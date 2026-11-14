/*
 * Reading the OMCI MIB — the OLT's own description of the service it has
 * provisioned on this ONU.
 *
 * This is the half of the device the config page cannot show. The keys in
 * `flash` are what WE asked for; the MIB is what the line actually built, and
 * when those two disagree the MIB is right. Nearly every "O5 but no traffic"
 * report on this hardware is settled by two of these tables, which is why they
 * have a page rather than a shell command.
 *
 * Three properties hold everything here together:
 *
 *   - It is read-only. No route reaches `omcicli mib set`.
 *   - Nothing derived from the request is ever concatenated into a command.
 *     run_to_buf_ex execve()s omcicli directly, so there is no shell to quote
 *     for -- but the arguments are still domain-checked, so a bad one fails as
 *     "not a MIB table" here instead of as whatever omcicli makes of it.
 *   - The output is returned verbatim. Every attribute this firmware prints is
 *     laid out differently from the last, and a parser in C would have to be
 *     rebuilt for each one; the browser can afford to be permissive, and the
 *     raw view is worth having on its own.
 */

#include "confd.h"
#include "buffers.h"
#include "http.h"
#include "omci.h"

/*
 * A class id or a table name. The names are exactly the set registered by
 * /lib/omci/mib_*.so in the image -- 81 of them on the 2022 base -- and the
 * numbers are their G.988 class ids; omcicli takes either.
 */
static int me_token_ok(const char *s)
{
	unsigned long i, n = 0, digits = 1;

	for (i = 0; s[i]; i++) {
		char c = s[i];

		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
		      (c >= '0' && c <= '9') || c == '_'))
			return 0;
		if (c < '0' || c > '9')
			digits = 0;
		else if (n <= 65535)
			n = n * 10 + (unsigned long)(c - '0');
	}
	/* A class id is a 16-bit number (G.988); omcicli would refuse more. */
	if (digits && (n < 1 || n > 65535))
		return 0;
	/* 39 fits emit_omci_json's me[40]; the longest captured table name,
	 * MacBridgePortPmMonitorHistoryData, is 33. */
	return i > 0 && i <= 39;
}

/*
 * Classes whose attributes carry a secret the OLT provisioned: 148
 * (authentication security method), 157 and 307 (large string and octet
 * string, which hold credentials among other things) and 65530 (LoIdAuth: the
 * LOID and password of the line). omcid masks them in the
 * dump, but an older image prints the bytes, so the route refuses these
 * classes itself rather than rely on the daemon. LargeString is the table name
 * of both 157 and 307, so the name is refused as a whole; "all" is every class
 * at once. Matching is case-insensitive and numeric ids are compared as
 * numbers, so 0148 is 148.
 */
static int me_secret(const char *s)
{
	static const char *const names[] = { "AuthSecMethod", "LargeString", "LoIdAuth", "all" };
	unsigned long i, n = 0;

	for (i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
		const char *a = s, *b = names[i];

		while (*a && *b && (*a | 0x20) == (*b | 0x20))
			a++, b++;
		if (!*a && !*b)
			return 1;
	}
	for (i = 0; s[i] >= '0' && s[i] <= '9'; i++)
		n = n * 10 + (unsigned long)(s[i] - '0');
	return !s[i] && (n == 148 || n == 157 || n == 307 ||
		     n == 65530);
}

/* An entity id, in the form omcicli prints them: hex, 0x optional, and 16
 * bits (G.988 entity ids are two bytes), so 1 to 4 digits. */
static int entity_ok(const char *s)
{
	unsigned long i = 0, digits = 0;

	if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X'))
		i = 2;
	if (!s[i])
		return 0;
	for (; s[i]; i++, digits++)
		if (hexval(s[i]) < 0 || digits >= 4)
			return 0;
	return 1;
}

/* Zero a buffer in a way the compiler may not drop as a dead store. */
static void wipe(char *p, unsigned long n)
{
	volatile char *v = p;

	while (n--)
		*v++ = 0;
}

/*
 * Run omcicli and answer with what it printed.
 *
 * `truncated` is reported rather than hidden. `mib get all` on a provisioned
 * line does not fit in any buffer worth giving it, and a silently short answer
 * would read as "the OLT provisioned nothing", which is the single most
 * misleading thing this page could say.
 */
static void emit_omcicli_h(int fd, char *const argv[], const char *hdr, int secret);

static void emit_omcicli(int fd, char *const argv[])
{
	emit_omcicli_h(fd, argv, 0, 0);
}

static void emit_omcicli_h(int fd, char *const argv[], const char *hdr, int secret)
{
	long got, code = -1;

	got = run_to_buf_ex(OMCICLI_PATH, argv, omci, sizeof(omci), &code,
			    OMCICLI_TIMEOUT_MS);
	/*
	 * -1 is "never ran at all" (pipe2/fork failed) and has no output worth
	 * showing. -2 is OMCICLI_TIMEOUT_MS firing: the child DID run, omci was
	 * killed for going silent, and whatever it printed before then is still
	 * in `omci` -- so that case falls through to the ordinary 200 response
	 * below, and the code check further down reports the timeout.
	 */
	if (got == -1) {
		respond(fd, "500 Internal Server Error", "application/json", hdr);
		put_fd(fd, "{\"error\":\"could not run omcicli\"}");
		return;
	}
	if (got < 0)
		got = 0;

	/* A missing omcicli on the secrets route is a 503 and no body at all:
	 * there is nothing to show and nothing that could leak. */
	if (secret && code == 127) {
		respond(fd, "503 Service Unavailable", "application/json", hdr);
		put_fd(fd, "{\"ok\":false,\"error\":\"no omcicli in this image\"}");
		wipe(omci, sizeof(omci));
		return;
	}
	respond(fd, "200 OK", "application/json", hdr);
	put_fd(fd, "{\"raw\":\"");
	put_json_cstr(fd, omci);
	put_fd(fd, "\",\"truncated\":");
	put_fd(fd, ((unsigned long)got + 1 >= sizeof(omci)) ? "true" : "false");

	/*
	 * 127 is run_to_buf_ex's own "execve failed", not omcicli's. Saying so
	 * separates "this image has no omcicli" from "omcicli did not like the
	 * arguments", which are fixed in completely different places.
	 *
	 * -2 is the OMCICLI_TIMEOUT_MS bound firing: omcicli was killed for not
	 * answering, most likely because omci_app itself is wedged (see
	 * odi-sfp-exporter's own notes on the same respawn bug). Reported
	 * separately so a stuck OMCI daemon shows as exactly that instead of as
	 * "omcicli refused the request", which would send you to look at the
	 * arguments instead of at omci_app.
	 */
	if (code == 0) {
		put_fd(fd, ",\"ok\":true}");
	} else if (code == 127) {
		put_fd(fd, ",\"ok\":false,\"error\":\"no omcicli in this image\"}");
	} else if (code == -2) {
		put_fd(fd, ",\"ok\":false,\"error\":\"omcicli timed out; omci_app may be stuck\"}");
	} else {
		put_fd(fd, ",\"ok\":false,\"error\":\"omcicli refused the request\"}");
	}
	if (secret)
		wipe(omci, sizeof(omci));
}

static void bad(int fd, const char *why)
{
	respond(fd, "400 Bad Request", "application/json", 0);
	put_fd(fd, "{\"error\":\"");
	put_json_cstr(fd, why);
	put_fd(fd, "\"}");
}

void emit_omci_json(int fd, const char *query)
{
	static char me[40], entity[16], what[16], cmd[16];
	char *argv[6];

	/* Check the return, not just the buffer: form_get decodes every value it
	 * walks past into `out`, so a query with no `cmd` at all can leave the
	 * last field's value sitting there. */
	if (!form_get(query, "cmd", cmd, sizeof(cmd))) {
		bad(fd, "cmd must be me, state, tables or dump");
		return;
	}

	/*
	 * `omcicli get tables` is NOT reachable, and that is the point.
	 *
	 * It breaks the thing this whole route exists to read. Reproduced twice
	 * from a freshly restarted omci_app on a stick: `mib get 84` answers,
	 * `get tables` returns ZERO bytes, and every `mib get` after it returns
	 * nothing until omci_app is restarted. `get sn`, `get devmode` and
	 * `get cflag` are all harmless in the same test, so it is this one
	 * command and not the `get` family, the call volume, or who forked it.
	 *
	 * It used to be offered here and the MIB tab called it on load, so
	 * opening that tab disabled the device's own MIB diagnostics -- on a
	 * page whose job is diagnosing a line. The table names are captured in
	 * scripts/fixtures/omci/_tables-names.txt and shipped as data instead;
	 * they change only with the base.
	 */
	if (seq(cmd, "tables")) {
		bad(fd, "refused: `omcicli get tables` wedges the MIB service on "
			"this firmware until omci_app is restarted");
		return;
	}

	/*
	 * The data-path dumps. Allowlisted by name rather than passed through,
	 * because `omcicli dump` also takes `avltree [avlkeyid]` and the
	 * argument shape differs per verb.
	 */
	if (seq(cmd, "dump")) {
		if (!form_get(query, "what", what, sizeof(what)) ||
		    (!seq(what, "conn") && !seq(what, "srvflow") &&
		     !seq(what, "qmap") && !seq(what, "tasks"))) {
			bad(fd, "dump takes conn, srvflow, qmap or tasks");
			return;
		}
		argv[0] = "omcicli"; argv[1] = "dump"; argv[2] = what; argv[3] = 0;
		emit_omcicli(fd, argv);
		return;
	}

	/*
	 * `omcicli state`: what omcid says of itself (ONU state, MIB data
	 * sync, dropped frames, the MIB resets and whether they are a loop),
	 * for the link check. odi-oss only: its omcid answers it from memory,
	 * read-only; the stock omcicli has no such verb and nothing here should
	 * find out what it does with one. /proc/odi_gpon/status is how this
	 * daemon tells the two apart elsewhere too (status.c).
	 */
	if (seq(cmd, "state")) {
		static char probe[64];

		if (read_file(GPON_STATUS, probe, sizeof(probe)) <= 0) {
			bad(fd, "state needs the odi-oss omcid");
			return;
		}
		argv[0] = "omcicli"; argv[1] = "state"; argv[2] = 0;
		emit_omcicli(fd, argv);
		return;
	}

	if (!seq(cmd, "me")) {
		bad(fd, "cmd must be me, state, tables or dump");
		return;
	}

	if (!form_get(query, "me", me, sizeof(me)) || !me_token_ok(me)) {
		bad(fd, "me must be a class id or a MIB table name");
		return;
	}

	if (me_secret(me)) {
		respond(fd, "403 Forbidden", "application/json", 0);
		put_fd(fd, "{\"error\":\"refused: this class holds secrets the OLT provisioned\"}");
		return;
	}

	/* The argv is fixed: only `me` and `entity`, each domain-checked, ever
	 * reach omcicli. No query field can add a flag, `--secrets` included. */
	argv[0] = "omcicli"; argv[1] = "mib"; argv[2] = "get"; argv[3] = me;
	argv[4] = 0;
	argv[5] = 0;

	/*
	 * The entity id is optional, and omitting it means "every instance",
	 * which is what the pages ask for. It is passed as its own argument
	 * because that is how `omcicli mib set <class> <entity> ...` takes it.
	 */
	if (form_get(query, "entity", entity, sizeof(entity)) && entity[0]) {
		if (!entity_ok(entity)) {
			bad(fd, "entity must be a hex id");
			return;
		}
		argv[4] = entity;
	}

	emit_omcicli(fd, argv);
}

/*
 * The phone lines the OLT provisioned, as `omcicli voip` prints them.
 *
 * The argv is a constant and carries no flag from the request, so the masked
 * view is all this route can ever return: it must never gain --secrets (the
 * secrets route below is the only caller that passes it, behind the password).
 * The output is returned verbatim like /api/omci; the browser parses it.
 */
void emit_voip_json(int fd)
{
	char *argv[3];

	argv[0] = "omcicli"; argv[1] = "voip"; argv[2] = 0;
	emit_omcicli_h(fd, argv, 0, 0);
}

/*
 * The same view with the SIP number, login and password in clear.
 *
 * Authentication has already happened (serve()), but the browser sends the
 * session cookie on its own, so the person must type the password again here. The
 * factory credential admin:admin is refused outright: a password everybody
 * knows protects nothing. A wrong password costs a second, like a failed login.
 * Nothing here is logged, the password and the output are wiped after use, and
 * respond() already marks every answer no-store.
 */
void emit_voip_secrets_json(int fd, char *body)
{
	char pass[512];
	char *argv[4];
	int ok;

	if (auth_is_default()) {
		respond(fd, "403 Forbidden", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"refused: this stick still has the factory "
			   "password. Set your own in Config first.\"}");
		return;
	}
	if (!form_get(body, "password", pass, sizeof(pass))) {
		wipe(body, slen(body));
		wipe(pass, sizeof(pass));
		respond(fd, "400 Bad Request", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"password is required\"}");
		return;
	}
	ok = password_matches(pass);
	wipe(pass, sizeof(pass));
	wipe(body, slen(body));
	if (!ok) {
		sleep_s(1);
		respond(fd, "403 Forbidden", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"wrong password\"}");
		return;
	}
	argv[0] = "omcicli"; argv[1] = "voip"; argv[2] = "--secrets"; argv[3] = 0;
	emit_omcicli_h(fd, argv, 0, 1);
}

/*
 * The router's report of its SIP registration, per phone port.
 *
 * The stick cannot see the router's SIP client, so the router tells it: a
 * script on the router posts `port` and `state` here (same credentials as the
 * rest of the UI) and omcid, with OMCI_VOIP_LINE_REPORT on, shows the OLT that
 * state instead of "config done" for as long as the report is fresh. The body
 * carries nothing else and the file keeps nothing else: no number, login,
 * server or password ever reaches this route, a log or the report.
 *
 * The factory admin:admin is refused as for the secrets route: anyone on the
 * LAN knows it, and a state the OLT will read is not theirs to set.
 */
static const char *const voip_states[] = {
	"none", "registered", "in_session", "failed_icmp", "failed_tcp",
	"failed_auth", "failed_timeout", "failed_server", "failed_invite_icmp",
	"failed_invite_tcp", "failed_invite_auth", "failed_invite_timeout",
	"failed_invite_server", 0
};

/* The stick's uptime in whole seconds, -1 when /proc/uptime is unreadable. */
static long voip_uptime_s(void)
{
	char buf[64];
	long n = read_file(UPTIME_FILE, buf, sizeof(buf)), v = 0;
	unsigned long i;

	if (n <= 0)
		return -1;
	for (i = 0; buf[i] >= '0' && buf[i] <= '9' && i < 10; i++)
		v = v * 10 + (buf[i] - '0');
	return i ? v : -1;
}

/* Whether line `i` of a report file is `LINE<p>=` and where its value starts
 * and ends; the value is "<state> <seconds>". */
static int voip_line_at(const char *buf, unsigned long i, unsigned long n,
			int *port, unsigned long *vs, unsigned long *ve)
{
	unsigned long e = i;

	while (e < n && buf[e] != '\n')
		e++;
	if (e - i < 8 || buf[i] != 'L' || buf[i + 1] != 'I' || buf[i + 2] != 'N' ||
	    buf[i + 3] != 'E' || buf[i + 4] < '1' || buf[i + 4] > '0' + VOIP_PORTS_MAX ||
	    buf[i + 5] != '=')
		return 0;
	*port = buf[i + 4] - '0';
	*vs = i + 6;
	*ve = e;
	return 1;
}

void emit_voip_status_post(int fd, char *body)
{
	char port[8], state[24], old[512], out[512];
	long up = voip_uptime_s(), got;
	unsigned long n = 0, i, k;
	int s, p;

	if (auth_is_default()) {
		respond(fd, "403 Forbidden", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"refused: this stick still has the factory "
			   "password. Set your own in Config first.\"}");
		return;
	}
	if (!form_get(body, "port", port, sizeof(port)) || port[1] ||
	    port[0] < '1' || port[0] > '0' + VOIP_PORTS_MAX) {
		respond(fd, "400 Bad Request", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"port must be 1 or 2\"}");
		return;
	}
	p = port[0] - '0';
	state[0] = 0;
	form_get(body, "state", state, sizeof(state));
	for (s = 0; voip_states[s] && !seq(state, voip_states[s]); s++)
		;
	if (!voip_states[s]) {
		respond(fd, "400 Bad Request", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"state is none, registered, in_session, "
			   "failed_icmp, failed_tcp, failed_auth, failed_timeout, failed_server, "
			   "failed_invite_icmp, failed_invite_tcp, failed_invite_auth, "
			   "failed_invite_timeout or failed_invite_server\"}");
		return;
	}
	if (up < 0) {
		respond(fd, "500 Internal Server Error", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"no uptime\"}");
		return;
	}
	/* The file is rewritten whole, every port: this port's new line, the
	 * others' as they were. A line that is not ours to read is dropped. */
	got = read_file(VOIP_REPORT_PATH, old, sizeof(old));
	for (k = 1; k <= VOIP_PORTS_MAX; k++) {
		const char *v;
		unsigned long vl;

		if ((int)k == p) {
			v = 0;
			vl = 0;
		} else {
			unsigned long j = 0, vs, ve;
			int lp;

			v = 0;
			vl = 0;
			while (got > 0 && j < (unsigned long)got) {
				if (voip_line_at(old, j, (unsigned long)got, &lp, &vs, &ve) &&
				    (unsigned long)lp == k) {
					v = old + vs;
					vl = ve - vs;
					break;
				}
				while (j < (unsigned long)got && old[j] != '\n')
					j++;
				j++;
			}
			if (!v)
				continue;
		}
		if (n + 40 + vl >= sizeof(out))
			break;
		out[n++] = 'L'; out[n++] = 'I'; out[n++] = 'N'; out[n++] = 'E';
		out[n++] = (char)('0' + k); out[n++] = '=';
		if (v) {
			for (i = 0; i < vl; i++)
				out[n++] = v[i];
		} else {
			char num[12];
			int d = 0;
			long t = up;

			for (i = 0; voip_states[s][i]; i++)
				out[n++] = voip_states[s][i];
			out[n++] = ' ';
			do {
				num[d++] = (char)('0' + t % 10);
				t /= 10;
			} while (t && d < (int)sizeof(num));
			while (d--)
				out[n++] = num[d];
		}
		out[n++] = '\n';
	}
	wipe(body, slen(body));
	if (write_file_atomic(VOIP_REPORT_PATH, out, n, 0644) < 0) {
		respond(fd, "500 Internal Server Error", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"could not store the report\"}");
		return;
	}
	respond(fd, "200 OK", "application/json", 0);
	put_fd(fd, "{\"ok\":true}");
}

void emit_voip_status_get(int fd)
{
	char buf[512];
	long got = read_file(VOIP_REPORT_PATH, buf, sizeof(buf)), up = voip_uptime_s();
	unsigned long j = 0, first = 1;

	respond(fd, "200 OK", "application/json", 0);
	put_fd(fd, "{\"ok\":true,\"ttl\":");
	put_u32_fd(fd, VOIP_REPORT_TTL_S);
	put_fd(fd, ",\"ports\":[");
	while (got > 0 && up >= 0 && j < (unsigned long)got) {
		unsigned long vs, ve, sp, stamp = 0, w;
		int p, ok = 0;

		if (voip_line_at(buf, j, (unsigned long)got, &p, &vs, &ve)) {
			for (sp = vs; sp < ve && buf[sp] != ' '; sp++)
				;
			for (w = sp + 1; w < ve && buf[w] >= '0' && buf[w] <= '9' && w < sp + 11; w++)
				stamp = stamp * 10 + (unsigned long)(buf[w] - '0');
			ok = sp < ve && w == ve && w > sp + 1 && (long)stamp <= up;
			if (ok) {
				if (!first)
					put_fd(fd, ",");
				first = 0;
				put_fd(fd, "{\"port\":");
				put_u32_fd(fd, (unsigned long)p);
				put_fd(fd, ",\"state\":\"");
				put_json_str(fd, buf + vs, sp - vs);
				put_fd(fd, "\",\"age\":");
				put_u32_fd(fd, (unsigned long)up - stamp);
				put_fd(fd, "}");
			}
		}
		while (j < (unsigned long)got && buf[j] != '\n')
			j++;
		j++;
	}
	put_fd(fd, "]}");
}
