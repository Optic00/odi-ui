/*
 * The HTTP layer: reading a request safely, deciding whether to answer it, and
 * the two ways bytes leave -- a response header and a static file.
 *
 * Everything here treats the request as hostile input, and the ordering rule in
 * http.h is not optional: request_path edits its input in place, so header_copy
 * and request_body must run BEFORE it, never after.
 */

#include "confd.h"
#include "buffers.h"
#include "http.h"

/* ------------------------------------------------------------------ HTTP --- */

/*
 * HTTP/1.1, with Connection: close on every answer, so the body ends where the
 * connection does and no Content-Length is needed. Keep-alive is not offered:
 * this server is serial, and a browser holding an idle connection open would
 * block every other request for as long as it kept it.
 */
static void respond_head(int fd, const char *status_line, const char *ctype,
			 const char *cache, const char *extra)
{
	put_fd(fd, "HTTP/1.1 ");
	put_fd(fd, status_line);
	put_fd(fd, "\r\nContent-Type: ");
	put_fd(fd, ctype);
	put_fd(fd, "\r\nCache-Control: ");
	put_fd(fd, cache);
	put_fd(fd, "\r\nConnection: close\r\n");
	/*
	 * What a browser is told about this page, on every response. The page
	 * must never be framed (a framed copy is a button an attacker can place
	 * under the operator pointer: reboot, add an ssh key), never sniffed
	 * into something else, and never leaks its address in a Referer.
	 * No `default-src`: index.html has one inline script (the theme, which
	 * has to run before first paint) and a script-src policy would block it.
	 */
	put_fd(fd, "X-Content-Type-Options: nosniff\r\n"
		   "X-Frame-Options: DENY\r\n"
		   "Referrer-Policy: no-referrer\r\n"
		   "Content-Security-Policy: frame-ancestors 'none'; base-uri 'none'; "
		   "form-action 'self'; object-src 'none'\r\n");
	if (extra)
		put_fd(fd, extra);
	put_fd(fd, "\r\n");
}

void respond(int fd, const char *status_line, const char *ctype,
		    const char *extra)
{
	respond_head(fd, status_line, ctype, "no-store", extra);
}

/*
 * Revalidation for what changes only with the image: the web assets and the
 * files behind /api/schema, meta, consumers and the like. The browser keeps
 * them and asks again on every load (no-cache), and an unchanged one costs a
 * 304 with no body. Measured on the stick, those bodies were most of the bytes
 * a page load sent.
 *
 * The tag is FNV-1a over the confd build and the bytes the answer is made
 * from, not a file date: the jffs2 and squashfs dates on the stick say nothing,
 * and a bind-mounted test file must not look unchanged. `private` keeps it out
 * of any shared cache. What the device holds (values, status) stays no-store.
 *
 * inm is copied at the top of serve(): by the time a route answers,
 * request_path has cut the headers short.
 */
static char inm[24];

void note_cache_request(const char *r)
{
	header_copy(r, "if-none-match", inm, sizeof(inm));
}

unsigned long etag_add(unsigned long h, const char *b, unsigned long len)
{
	unsigned long i;

	for (i = 0; i < len; i++)
		h = ((h ^ (unsigned char)b[i]) * 16777619UL) & 0xffffffffUL;
	return h;
}

unsigned long etag_start(void)
{
	static const char build[] = BUILD_ID;

	return etag_add(2166136261UL, build, sizeof(build) - 1);
}

int respond_tagged(int fd, const char *ctype, unsigned long h)
{
	static const char hexd[] = "0123456789abcdef";
	char tag[11], hdr[32];
	unsigned long i, n = 0;

	tag[0] = '"';
	for (i = 0; i < 8; i++)
		tag[1 + i] = hexd[(h >> (28 - 4 * i)) & 0xf];
	tag[9] = '"';
	tag[10] = 0;

	for (i = 0; "ETag: "[i]; i++)
		hdr[n++] = "ETag: "[i];
	for (i = 0; tag[i]; i++)
		hdr[n++] = tag[i];
	hdr[n++] = '\r';
	hdr[n++] = '\n';
	hdr[n] = 0;

	if (seq(inm, tag)) {
		respond_head(fd, "304 Not Modified", ctype, "private, no-cache", hdr);
		return 1;
	}
	respond_head(fd, "200 OK", ctype, "private, no-cache", hdr);
	return 0;
}

int respond_cached(int fd, const char *ctype, const char *body, unsigned long len)
{
	return respond_tagged(fd, ctype, etag_add(etag_start(), body, len));
}

/*
 * Extract the request path. Returns a pointer into req, NUL-terminated in
 * place. A request line that does not look like "METHOD path HTTP/x" yields 0
 * rather than a guess.
 */
char *request_path(char *r, char **method)
{
	unsigned long i = 0, s;

	*method = r;
	while (r[i] && r[i] != ' ' && r[i] != '\r' && r[i] != '\n')
		i++;
	if (r[i] != ' ')
		return 0;
	r[i++] = 0;

	s = i;
	while (r[i] && r[i] != ' ' && r[i] != '\r' && r[i] != '\n')
		i++;
	if (r[i] != ' ')
		return 0;
	r[i] = 0;
	return r + s;
}

char *request_body(char *r)
{
	unsigned long i;

	for (i = 0; r[i]; i++)
		if (r[i] == '\r' && r[i+1] == '\n' && r[i+2] == '\r' && r[i+3] == '\n')
			return r + i + 4;
	return r + slen(r);
}

/*
 * Copy a header's value into `out`. Case-insensitive on the name.
 *
 * Non-destructive, deliberately. The obvious implementation NUL-terminates the
 * value in place, and that quietly breaks any request with a body:
 * Content-Length is typically the last header, so terminating it overwrites the
 * CR of the CRLFCRLF that marks where the body starts, and the body then
 * appears to be empty. Harmless while every route is a GET; fatal the moment
 * the write path starts POSTing. Parsers that edit their input are how that
 * keeps happening — see also the note in serve() about request_path().
 */
int header_copy(const char *r, const char *name, char *out, unsigned long cap)
{
	unsigned long i = 0, n = slen(name);

	out[0] = 0;
	for (;;) {
		unsigned long k = 0;

		while (r[i] && r[i] != '\n')
			i++;
		if (!r[i])
			return 0;
		i++;
		if (!r[i] || r[i] == '\r' || r[i] == '\n')
			return 0;              /* end of headers */

		while (k < n) {
			char a = r[i + k], b = name[k];

			if (a >= 'A' && a <= 'Z')
				a = (char)(a - 'A' + 'a');
			if (b >= 'A' && b <= 'Z')
				b = (char)(b - 'A' + 'a');
			if (a != b)
				break;
			k++;
		}
		if (k == n && r[i + k] == ':') {
			unsigned long v = i + k + 1, o = 0;

			while (r[v] == ' ')
				v++;
			while (r[v] && r[v] != '\r' && r[v] != '\n' && o + 1 < cap)
				out[o++] = r[v++];
			out[o] = 0;
			return o > 0;
		}
	}
}

/*
 * Read a whole request: the headers, then exactly Content-Length bytes of body.
 *
 * One read() is not a request. TCP is a byte stream, and a browser routinely
 * puts the headers in one segment and the body in the next -- so a POST arrived
 * with an empty body and handle_write answered {"results":[],"apply":"none"},
 * reporting no error and writing nothing.
 *
 * The truncation case was worse. A body larger than req[] was cut mid-value,
 * url_decode accepted the fragment, write_key wrote it, and the read-back then
 * compared the fragment against ITSELF and reported ok:true. Every guard in the
 * write path was satisfied by a value the user never typed. A request that does
 * not fit is therefore refused outright, not trimmed.
 *
 * Returns the byte count, -1 if the peer gave up mid-request, -2 if it does not
 * fit.
 */
long read_request(int conn, char *buf, unsigned long cap,
		  unsigned long *body_have, unsigned long *body_want)
{
	unsigned long got = 0, hdr = 0, want = 0;
	unsigned long t0 = mono_ms();
	int have_hdr = 0;

	*body_have = 0;
	*body_want = 0;

	for (;;) {
		long n;
		unsigned long i;

		/*
		 * Stop as soon as the whole body is in, OR as soon as it is
		 * known it cannot be. The second case is what makes the upload
		 * route's size guard a real pre-body check: without it this
		 * went on filling the buffer first, so a request DECLARING
		 * 20 MB while sending sixteen bytes blocked here for the full
		 * socket timeout and the guard was never reached at all.
		 *
		 * It also means an oversized body on any other route is
		 * refused the moment the headers are read, rather than after
		 * 16 KB of it has been taken.
		 */
		if (have_hdr && (got >= hdr + want || hdr + want + 1 > cap)) {
			*body_have = got - hdr;
			*body_want = want;
			return (long)got;
		}
		/* The HEADERS not fitting is still fatal: there is no route
		 * that wants a request line this daemon could not parse. */
		if (!have_hdr && got + 1 >= cap)
			return REQ_TOO_LARGE;

		/* The sum of the waits is bounded, not just each one: see
		 * REQUEST_DEADLINE_MS. */
		{
			long left = REQUEST_DEADLINE_MS - (long)(mono_ms() - t0);

			if (left <= 0 || !wait_readable(conn, left))
				return REQ_INCOMPLETE;
		}
		n = syscall3(__NR_read, conn, (long)(buf + got), cap - got - 1);
		if (n <= 0)
			return REQ_INCOMPLETE;
		got += (unsigned long)n;
		buf[got] = 0;

		if (have_hdr)
			continue;

		for (i = 0; i + 3 < got; i++) {
			if (buf[i] == '\r' && buf[i + 1] == '\n' &&
			    buf[i + 2] == '\r' && buf[i + 3] == '\n') {
				have_hdr = 1;
				hdr = i + 4;
				break;
			}
		}
		if (!have_hdr)
			continue;

		/* A GET has no Content-Length and wants nothing more. An absent
		 * or unparsable header is treated as zero rather than guessed
		 * at: a body we were not told the length of is one we cannot
		 * know we have all of. */
		if (header_copy(buf, "content-length", hdrbuf, sizeof(hdrbuf))) {
			unsigned long v = 0, k;

			for (k = 0; hdrbuf[k]; k++) {
				if (hdrbuf[k] < '0' || hdrbuf[k] > '9') {
					v = 0;
					break;
				}
				v = v * 10 + (unsigned long)(hdrbuf[k] - '0');
				/* Bound the arithmetic, not the route. The
				 * upload has its own limit; this only stops a
				 * declared length from wrapping. */
				if (v > MAX_BODY) {
					v = MAX_BODY + 1;
					break;
				}
			}
			want = v;
		}
	}
}

/*
 * Reject a cross-site write.
 *
 * HTTP Basic has no session and no token: the browser replays the credential on
 * every request to this host, including one triggered by a page on some other
 * site. Without this, any page the operator visits can POST to /api/firmware
 * with action=reboot, or to /api/config with _confirm=identity. A urlencoded
 * form POST is a CORS-simple request, so there is no preflight to stop it, and
 * the attacker not being able to READ the reply does not matter -- every one of
 * those routes is a write.
 *
 * The test is Origin-when-present. Every current browser sends Origin on a
 * cross-origin POST, form submissions included, so the attack is blocked; curl
 * and the repo's own scripts send none and keep working. That asymmetry is the
 * point -- a check that demanded a header would break every non-browser client
 * for no gain, since an attacker who can set arbitrary headers is not doing CSRF
 * in the first place.
 */
int same_origin(const char *r)
{
	char origin[256], host[128];
	const char *o = origin;

	if (!header_copy(r, "origin", origin, sizeof(origin)))
		return 1;                  /* not a browser-initiated write */
	if (!header_copy(r, "host", host, sizeof(host)))
		return 0;

	if (spre(o, "http://"))
		o += 7;
	else if (spre(o, "https://"))
		o += 8;
	else
		return 0;                  /* "null", or something exotic */

	return seq(o, host);
}


/*
 * Whether `host` (a Host header, port allowed) is one a browser could only
 * have reached by addressing this stick on the LAN.
 *
 * DNS rebinding is a web page that answers a name it owns first with its own
 * server and then with the stick's address: the browser then treats the stick
 * as that page's own origin, so the Origin check above passes (Origin and
 * Host are both the attacker's name) and the page can read and write
 * everything. What it cannot do is make the browser send an IP literal or a
 * name it does not own as the Host, so the defence is to answer only those:
 *
 *   - an IP literal, v4 or bracketed v6;
 *   - a single label (no dot): `odi`, `localhost`, a search-domain name;
 *   - the suffixes that are private by convention and cannot be registered:
 *     .local .lan .localdomain .home.arpa .internal .localhost .home;
 *   - a name listed in /etc/config/confd.hosts, one per line, for a site that
 *     gives the stick a public-looking name in its own DNS.
 *
 * A trailing dot (`stick.`) is not a single label and is refused on purpose:
 * it is how a browser is told "this is already fully qualified".
 */
static int lower_eq(char a, char b)
{
	if (a >= 'A' && a <= 'Z')
		a = (char)(a - 'A' + 'a');
	if (b >= 'A' && b <= 'Z')
		b = (char)(b - 'A' + 'a');
	return a == b;
}

static int name_ends(const char *name, unsigned long n, const char *suffix)
{
	unsigned long sl = slen(suffix), k;

	if (n < sl)
		return 0;
	for (k = 0; k < sl; k++)
		if (!lower_eq(name[n - sl + k], suffix[k]))
			return 0;
	return 1;
}

static int host_listed(const char *name, unsigned long n)
{
	char list[1024];
	unsigned long i = 0;
	long got = read_file(HOSTS_PATH, list, sizeof(list));

	if (got <= 0)
		return 0;
	while (list[i]) {
		unsigned long ls = i, le = i, k = 0;

		while (list[le] && list[le] != '\n' && list[le] != '\r')
			le++;
		if (le - ls == n) {
			while (k < n && lower_eq(list[ls + k], name[k]))
				k++;
			if (k == n)
				return 1;
		}
		i = le;
		while (list[i] == '\n' || list[i] == '\r')
			i++;
	}
	return 0;
}

static int host_ok(const char *host)
{
	static const char *const suffix[] = { ".local", ".lan", ".localdomain",
		".home.arpa", ".internal", ".localhost", ".home", 0 };
	unsigned long n = 0, i;
	int dots = 0, alldigit = 1;

	if (host[0] == '[') {
		/* IPv6 literal: hex, colons and dots between the brackets. */
		for (i = 1; host[i] && host[i] != ']'; i++)
			if (hexval(host[i]) < 0 && host[i] != ':' && host[i] != '.')
				return 0;
		return host[i] == ']' && i > 2;
	}
	while (host[n] && host[n] != ':')
		n++;
	if (!n)
		return 0;
	for (i = 0; i < n; i++) {
		if (host[i] == '.')
			dots++;
		else if (host[i] < '0' || host[i] > '9')
			alldigit = 0;
	}
	if (alldigit && dots == 3)
		return 1;
	if (!dots)
		return 1;
	for (i = 0; suffix[i]; i++)
		if (name_ends(host, n, suffix[i]))
			return 1;
	return host_listed(host, n);
}

/*
 * The checks that apply to every request, authenticated or not, before the
 * credential is even looked at: 0 when the request is fine, else the reason
 * (a plain-text line for the 403).
 *
 * Sec-Fetch-Site is sent by every current browser and by nothing else. A
 * cross-site or same-site value means a page that is not this one caused the
 * request. The Origin check covers writes; this is what stops a GET from a
 * foreign page, such as the diagnostics bundle, which holds the only thread
 * for up to a minute.
 */
/* Offset of the request target in "METHOD target HTTP/x"; read only. */
static unsigned long path_off(const char *r)
{
	unsigned long i = 0;

	while (r[i] && r[i] != ' ' && r[i] != '\r' && r[i] != '\n')
		i++;
	return r[i] == ' ' ? i + 1 : i;
}

int request_target(const char *r, char *out, unsigned long cap)
{
	unsigned long i = path_off(r), o = 0;

	while (r[i] && r[i] != ' ' && r[i] != '?' && r[i] != '\r' && r[i] != '\n') {
		if (o + 1 >= cap) {
			out[0] = 0;
			return 0;
		}
		out[o++] = r[i++];
	}
	out[o] = 0;
	return o > 0;
}

int header_has(const char *r, const char *name, const char *needle)
{
	char v[512];
	unsigned long i, k, n = slen(needle);

	if (!header_copy(r, name, v, sizeof(v)))
		return 0;
	for (i = 0; v[i]; i++) {
		for (k = 0; k < n && v[i + k] == needle[k]; k++)
			;
		if (k == n)
			return 1;
	}
	return 0;
}

const char *request_refusal(const char *r)
{
	char host[128], site[32], mode[16], dest[16];

	/*
	 * header_copy cuts a value that does not fit, and a cut Host can look
	 * like something else: 127 characters of one long label, or a prefix
	 * ending in ".lan", with the attacker's own domain after the cut. A
	 * Host that fills the buffer is refused, never judged by its prefix.
	 */
	if (header_copy(r, "host", host, sizeof(host)) &&
	    (slen(host) + 1 >= sizeof(host) || !host_ok(host)))
		return "this name is not one for this stick; open it by its IP address "
		       "or list the name in /etc/config/confd.hosts\n";
	if (header_copy(r, "sec-fetch-site", site, sizeof(site)) &&
	    (seq(site, "cross-site") || seq(site, "same-site"))) {
		/*
		 * A link followed from another page is a top-level navigation
		 * and is the operator acting: the UI itself offers one, to the
		 * stick new address after a move, and that is cross-site by
		 * definition. A fetch, an image, a script or a frame is not.
		 * Never for /api/: a followed link has no business there, and
		 * it is where the work and the data are.
		 */
		if (!spre(r + path_off(r), "/api/") &&
		    header_copy(r, "sec-fetch-mode", mode, sizeof(mode)) &&
		    header_copy(r, "sec-fetch-dest", dest, sizeof(dest)) &&
		    seq(mode, "navigate") && seq(dest, "document"))
			return 0;
		return "cross-site request refused\n";
	}
	return 0;
}

/*
 * Load the expected credential into credbuf.
 *
 * /etc/config/confd.auth when it has content, DEFAULT_AUTH otherwise. Returns
 * its length; sets *is_default when the fallback was used.
 *
 * On a safe-mode boot of odi-oss (SAFEMODE_FLAG) the file is not read at
 * all: the recovery boot accepts the default credential, in memory only,
 * so a forgotten password can be replaced. The file is left alone, and a
 * password saved meanwhile is written to it and in force from the next
 * boot.
 *
 * A file that exists but is empty counts as absent. That is not pedantry: the
 * obvious way to clear a password is to truncate the file, and treating the
 * result as "no credential accepted" would lock the operator out of the device
 * they were trying to change the password on.
 *
 * Only absent or empty falls back. A file that is there but cannot be read
 * (an I/O error on the flash, no file descriptor left under load, a
 * directory in its place) answers -1, and every login is refused until it
 * reads again: falling back there would put the password everybody knows
 * in force on a stick whose owner set another one. Safe mode is the way in
 * if it never reads again.
 */
/* ENOENT: 2 on MIPS o32 as everywhere (the low errno numbers are shared). */
#define ENOENT_ 2

static long load_credential(int *is_default)
{
	long want = file_exists(SAFEMODE_FLAG) ? 0 : read_file(AUTH_PATH, credbuf, sizeof(credbuf));
	unsigned long k;

	if (want > 0) {
		/* trim trailing newline/CR so an editor-written file works */
		while (want > 0 && (credbuf[want - 1] == '\n' || credbuf[want - 1] == '\r'))
			credbuf[--want] = 0;
	}
	if (want > 0) {
		if (is_default)
			*is_default = 0;
		return want;
	}
	if (want < 0 && want != -ENOENT_)
		return -1;

	for (k = 0; DEFAULT_AUTH[k] && k + 1 < sizeof(credbuf); k++)
		credbuf[k] = DEFAULT_AUTH[k];
	credbuf[k] = 0;
	if (is_default)
		*is_default = 1;
	return (long)k;
}

/*
 * Whether the credential in force IS the built-in default.
 *
 * Deliberately not "is the file missing": a file containing admin:admin leaves
 * you on the default password while making the warning go away, which is the
 * worst of both. The question the page needs answered is "is this stick on the
 * credential everybody knows", and that is this.
 */
int auth_is_default(void)
{
	long want = load_credential(0);
	unsigned long i;

	for (i = 0; DEFAULT_AUTH[i]; i++)
		if ((long)i >= want || credbuf[i] != DEFAULT_AUTH[i])
			return 0;
	return want == (long)i;
}

/*
 * Write a new credential file.
 *
 * Constrained, not sanitised: a value that does not fit the file format is
 * refused rather than rewritten into one that does. The file is one line of
 * `user:password`, so the username cannot contain a colon and neither half can
 * contain a newline -- a credential mangled on the way in is one nobody can
 * log in with afterwards, on a device where "afterwards" may mean a site visit.
 */
int set_credential(const char *user, const char *pass, const char **why)
{
	unsigned long u = 0, p = 0, n = 0;

	for (u = 0; user[u]; u++) {
		if (user[u] == ':') {
			*why = "the username cannot contain a colon";
			return 0;
		}
		if (user[u] < 0x21 || user[u] > 0x7e) {
			*why = "the username must be printable, with no spaces";
			return 0;
		}
	}
	if (!u || u > 64) {
		*why = "the username must be 1 to 64 characters";
		return 0;
	}

	for (p = 0; pass[p]; p++) {
		if (pass[p] < 0x20 || pass[p] > 0x7e) {
			*why = "the password must be printable ASCII";
			return 0;
		}
	}
	if (p < 4 || p > 128) {
		*why = "the password must be 4 to 128 characters";
		return 0;
	}
	if (u + 1 + p + 1 > sizeof(credbuf)) {
		*why = "too long";
		return 0;
	}

	for (n = 0; n < u; n++)
		credbuf[n] = user[n];
	credbuf[n++] = ':';
	for (p = 0; pass[p]; p++)
		credbuf[n++] = pass[p];
	credbuf[n] = 0;

	/* 0600: the file sits in /etc/config next to the device identity, and
	 * this daemon is not the only thing that can read that directory. */
	if (write_file_atomic(AUTH_PATH, credbuf, n, 0600) < 0) {
		*why = "could not write /etc/config/confd.auth";
		return 0;
	}
	*why = 0;
	return 1;
}

/*
 * Whether `pass` is the password half of the credential in force. For the
 * routes that make the caller repeat it before showing a secret: the Basic
 * header the browser replays is not proof that the person at the keyboard
 * knows it. Constant-time over the credential, length folded in, like
 * authorised(). The username half is not asked again.
 */
int password_matches(const char *pass)
{
	long want = load_credential(0);
	unsigned long colon = 0, i, plen = slen(pass);
	int diff = 0;

	if (want <= 0)
		return 0;
	while ((long)colon < want && credbuf[colon] != ':')
		colon++;
	if ((long)colon >= want)
		return 0;
	if (plen != (unsigned long)want - colon - 1)
		diff = 1;
	for (i = 0; i < (unsigned long)want - colon - 1; i++)
		diff |= credbuf[colon + 1 + i] ^ (i < plen ? pass[i] : 0);
	return diff == 0;
}

/*
 * HTTP Basic, against user:password in /etc/config/confd.auth -- or against
 * DEFAULT_AUTH when that file has never been written. See confd.h for why the
 * fallback exists rather than a refusal, and note that it is a fallback to a
 * WEAKER credential, not to none: every request is still checked, the
 * comparison is still constant-time, and a failure still costs a second.
 */
static int basic_ok(const char *r)
{
	long n, want;
	unsigned long i = 0;
	int diff = 0;

	want = load_credential(0);
	if (want <= 0)
		return 0;

	if (!header_copy(r, "authorization", hdrbuf, sizeof(hdrbuf)))
		return 0;
	if (!spre(hdrbuf, "Basic "))
		return 0;

	n = b64decode(hdrbuf + 6, slen(hdrbuf + 6), authbuf, sizeof(authbuf));
	if (n < 0)
		return 0;

	/* Compare every byte regardless, so timing does not leak the prefix.
	 * A length mismatch is folded in rather than returned early. */
	if (n != want)
		diff = 1;
	for (i = 0; i < (unsigned long)want && i + 1 < sizeof(authbuf); i++)
		diff |= (authbuf[i] ^ credbuf[i]);
	return diff == 0;
}

/*
 * Whether `user` and `pass` are the credential in force, for the sign-in
 * form. The same constant-time comparison as basic_ok, over "user:pass".
 */
int credential_matches(const char *user, const char *pass)
{
	long want = load_credential(0);
	unsigned long u = slen(user), p = slen(pass), n = 0, k, i;
	int diff = 0;

	/* Too long for the buffer is too long to be the credential. */
	if (want <= 0 || u + 1 + p + 1 > sizeof(authbuf))
		return 0;
	for (k = 0; k < u; k++)
		authbuf[n++] = user[k];
	authbuf[n++] = ':';
	for (k = 0; k < p; k++)
		authbuf[n++] = pass[k];
	authbuf[n] = 0;
	if ((long)n != want)
		diff = 1;
	for (i = 0; i < (unsigned long)want && i + 1 < sizeof(authbuf); i++)
		diff |= (authbuf[i] ^ credbuf[i]);
	for (i = 0; i < sizeof(authbuf); i++)
		((volatile char *)authbuf)[i] = 0;
	return diff == 0;
}

/* ------------------------------------------------------------- sessions --- */

/*
 * A browser signs in once, on /login, and is handed a random token in an
 * HttpOnly, SameSite=Strict cookie; every request after that is checked
 * against this table. The token never holds the password, so the password
 * crosses the network once per sign-in instead of with every request, as it
 * does under Basic. Sign out deletes the row, which ends the session for
 * certain: Basic could only ask the browser to forget, and Chromium shows its
 * own password dialog when asked.
 *
 * RAM only. A restart signs everyone out, which costs one sign-in and saves
 * writing tokens to a flash partition every other process can read.
 */
struct session {
	char tok[33];          /* 32 hex digits; empty when the row is free */
	unsigned long born;    /* mono_s() at sign-in */
	unsigned long used;    /* mono_s() at the last request */
	/*
	 * Which row was used last, from a counter. Not `used`: whole seconds
	 * tie for every sign-in made in the same second, and a tie dropped the
	 * session that had just signed in.
	 */
	unsigned long order;
};

static unsigned long session_tick;

static struct session sessions[SESSION_SLOTS];
/* The row the request being served signed in with, -1 for none. */
static int cur_session = -1;

/* Seconds on the monotonic clock, 0 when it cannot be read. */
static unsigned long mono_s(void)
{
	long ts[2];

	if (syscall3(__NR_clock_gettime, CLOCK_MONOTONIC, (long)ts, 0) < 0)
		return 0;
	return (unsigned long)ts[0];
}

static void session_clear(int i)
{
	unsigned long k;

	for (k = 0; k < sizeof(sessions[i].tok); k++)
		((volatile char *)sessions[i].tok)[k] = 0;
	sessions[i].born = sessions[i].used = sessions[i].order = 0;
}

/* Drop the rows that have run out. */
static void session_expire(unsigned long now)
{
	int i;

	for (i = 0; i < SESSION_SLOTS; i++)
		if (sessions[i].tok[0] &&
		    (now - sessions[i].used > SESSION_IDLE_S ||
		     now - sessions[i].born > SESSION_MAX_S))
			session_clear(i);
}

/*
 * The token in the request's session cookie, copied into out[33]. 0 when
 * there is none, or when it is not exactly 32 hex digits.
 */
static int cookie_token(const char *r, char *out)
{
	char c[1024];
	unsigned long i = 0, n = slen(SESSION_COOKIE), k;

	out[0] = 0;
	if (!header_copy(r, "cookie", c, sizeof(c)))
		return 0;
	while (c[i]) {
		while (c[i] == ' ' || c[i] == ';')
			i++;
		for (k = 0; k < n && c[i + k] == SESSION_COOKIE[k]; k++)
			;
		if (k == n && c[i + n] == '=') {
			i += n + 1;
			for (k = 0; k < 32 && hexval(c[i + k]) >= 0; k++)
				out[k] = c[i + k];
			out[k] = 0;
			if (k == 32 && (!c[i + k] || c[i + k] == ';' || c[i + k] == ' '))
				return 1;
			out[0] = 0;
			return 0;
		}
		while (c[i] && c[i] != ';')
			i++;
	}
	return 0;
}

/*
 * The row whose token the request carries, -1 for none. Every live row is
 * compared in full, so the time taken does not say which row came close.
 */
static int session_find(const char *r)
{
	char tok[33];
	unsigned long now = mono_s(), k;
	int i, hit = -1;

	if (!now || !cookie_token(r, tok))
		return -1;
	session_expire(now);
	for (i = 0; i < SESSION_SLOTS; i++) {
		int diff = 0;

		if (!sessions[i].tok[0])
			continue;
		for (k = 0; k < 32; k++)
			diff |= sessions[i].tok[k] ^ tok[k];
		if (!diff)
			hit = i;
	}
	if (hit >= 0) {
		sessions[hit].used = now;
		sessions[hit].order = ++session_tick;
	}
	return hit;
}

/*
 * Start a session and copy its token into tok[33]. 0 when no random bytes or
 * no clock could be had: no session is better than a guessable one.
 */
int session_start(char *tok)
{
	static const char hex[] = "0123456789abcdef";
	char raw[17];
	unsigned long now = mono_s(), k;
	int i, slot = -1;

	tok[0] = 0;
	if (!now || read_file(RANDOM_PATH, raw, sizeof(raw)) != 16)
		return 0;
	session_expire(now);
	for (i = 0; i < SESSION_SLOTS; i++) {
		if (!sessions[i].tok[0]) {
			slot = i;
			break;
		}
		if (slot < 0 || sessions[i].order < sessions[slot].order)
			slot = i;
	}
	for (k = 0; k < 16; k++) {
		sessions[slot].tok[2 * k] = hex[(raw[k] >> 4) & 15];
		sessions[slot].tok[2 * k + 1] = hex[raw[k] & 15];
		((volatile char *)raw)[k] = 0;
	}
	sessions[slot].tok[32] = 0;
	sessions[slot].born = sessions[slot].used = now;
	sessions[slot].order = ++session_tick;
	str_copy(tok, sessions[slot].tok, 33);
	return 1;
}

/* End the session the request being served signed in with, if any. */
void session_end_current(const char *r)
{
	int i = session_find(r);

	if (i >= 0)
		session_clear(i);
}

/*
 * End every session but the one the request being served signed in with:
 * after a password change, a browser that signed in with the old password is
 * not signed in any more. The browser that made the change stays signed in.
 */
void session_end_others(void)
{
	int i;

	for (i = 0; i < SESSION_SLOTS; i++)
		if (i != cur_session)
			session_clear(i);
}

/*
 * Whether the request is signed in: AUTH_SESSION for a live session cookie,
 * AUTH_BASIC for a correct HTTP Basic header (curl and scripts), 0 otherwise.
 * The cookie is looked at first and, when it is good, Basic is not looked at.
 */
int authorised(const char *r)
{
	cur_session = session_find(r);
	if (cur_session >= 0)
		return AUTH_SESSION;
	return basic_ok(r) ? AUTH_BASIC : 0;
}

/*
 * Decode one application/x-www-form-urlencoded token, stopping at `stop`.
 * Returns the index just past what it consumed, or 0 on a malformed escape —
 * rejected rather than passed through, so a mangled field cannot quietly become
 * a different one.
 */
unsigned long url_decode(const char *in, unsigned long i, char stop,
				char *out, unsigned long cap)
{
	unsigned long o = 0;

	while (in[i] && in[i] != stop && in[i] != '&') {
		char c = in[i];

		if (c == '+') {
			c = ' ';
			i++;
		} else if (c == '%') {
			int hi = hexval(in[i + 1]), lo = hexval(in[i + 2]);

			if (hi < 0 || lo < 0)
				return 0;
			c = (char)((hi << 4) | lo);
			/* %00 would end the C string here: the text validated,
			 * written and read back would be the part before it,
			 * reported as the value that was sent. */
			if (!c) {
				out[0] = 0;
				return 0;
			}
			i += 3;
		} else {
			i++;
		}
		/*
		 * A token that does not fit is refused like a bad escape, not
		 * cut. Cut, it was validated, written and read back against
		 * itself, and the page was told a value it never typed was
		 * saved (the same failure read_request describes for a whole
		 * body, here for one field).
		 */
		if (o + 1 >= cap) {
			out[0] = 0;
			return 0;
		}
		out[o++] = c;
	}
	out[o] = 0;
	return i;
}

/* Step over one token without decoding it: the index of its end. For the
 * fields of a form body that the caller is not asking about, so that a long
 * value it does not want cannot fail the one it does. */
unsigned long url_skip(const char *in, unsigned long i)
{
	while (in[i] && in[i] != '&')
		i++;
	return i;
}

/* One named field out of a urlencoded body. */
int form_get(const char *body, const char *want, char *out, unsigned long cap)
{
	char name[64];
	unsigned long i = 0;

	out[0] = 0;
	while (body[i]) {
		unsigned long k = url_decode(body, i, '=', name, sizeof(name));

		if (!k)
			return 0;
		i = k;
		if (body[i] == '=')
			i++;
		if (seq(name, want)) {
			/* Too long or badly encoded: no value, not a prefix. */
			i = url_decode(body, i, 0, out, cap);
			if (!i) {
				out[0] = 0;
				return 0;
			}
			return 1;
		}
		i = url_skip(body, i);
		if (body[i] == '&')
			i++;
	}
	out[0] = 0;
	return 0;
}

/* Whether a urlencoded body names a field at all, whatever it holds. For a
 * field whose absence means something: form_get answers 0 for a value that is
 * too long or badly encoded as well. */
int form_has(const char *body, const char *want)
{
	char name[64];
	unsigned long i = 0;

	while (body[i]) {
		unsigned long k = url_decode(body, i, '=', name, sizeof(name));

		if (!k)
			return 0;
		if (seq(name, want))
			return 1;
		i = url_skip(body, k);
		if (body[i] == '&')
			i++;
	}
	return 0;
}

/* Serve a static file, preferring the /etc/config override. */
void serve_static(int fd, const char *name, const char *ctype)
{
	char path[128];
	unsigned long n = 0, k;
	long got;

	for (k = 0; WEB_DIR_OVR[k] && n + 1 < sizeof(path); k++)
		path[n++] = WEB_DIR_OVR[k];
	for (k = 0; name[k] && n + 1 < sizeof(path); k++)
		path[n++] = name[k];
	path[n] = 0;

	got = read_file(path, filebuf, sizeof(filebuf));
	if (got <= 0) {
		n = 0;
		for (k = 0; WEB_DIR[k] && n + 1 < sizeof(path); k++)
			path[n++] = WEB_DIR[k];
		for (k = 0; name[k] && n + 1 < sizeof(path); k++)
			path[n++] = name[k];
		path[n] = 0;
		got = read_file(path, filebuf, sizeof(filebuf));
	}
	if (got <= 0) {
		respond(fd, "404 Not Found", "text/plain", 0);
		put_fd(fd, "not found\n");
		return;
	}
	if (respond_cached(fd, ctype, filebuf, (unsigned long)got))
		return;
	write_all(fd, filebuf, (unsigned long)got);
}

/*
 * Every asset, in one list. Adding a module to the UI is a line here and a file
 * in web/ -- and scripts/check-assets.py asserts those two agree, because a
 * file with no row is dead weight on a jffs2 partition that is already half
 * spent, and a row with no file is a 404 nobody notices until the page is
 * blank.
 */
const struct web_asset web_assets[] = {
	{ "/",              "index.html",  "text/html; charset=utf-8" },
	{ "/index.html",    "index.html",  "text/html; charset=utf-8" },
	{ "/login",         "login.html",  "text/html; charset=utf-8" },
	{ "/login.js",      "login.js",    "application/javascript" },
	{ "/style.css",     "style.css",   "text/css" },
	{ "/app.js",        "app.js",      "application/javascript" },
	{ "/dom.js",        "dom.js",      "application/javascript" },
	{ "/state.js",      "state.js",    "application/javascript" },
	{ "/status.js",     "status.js",   "application/javascript" },
	{ "/flow.js",       "flow.js",     "application/javascript" },
	{ "/overview.js",   "overview.js", "application/javascript" },
	{ "/validate.js",   "validate.js", "application/javascript" },
	{ "/config.js",     "config.js",   "application/javascript" },
	{ "/expert.js",     "expert.js",   "application/javascript" },
	{ "/lanroutes.js",  "lanroutes.js", "application/javascript" },
	{ "/save.js",       "save.js",     "application/javascript" },
	{ "/firmware.js",   "firmware.js", "application/javascript" },
	{ "/omci.js",       "omci.js",     "application/javascript" },
	{ "/services.js",   "services.js", "application/javascript" },
	{ "/mebrowser.js",  "mebrowser.js", "application/javascript" },
	{ "/phone.js",      "phone.js",     "application/javascript" },
	{ "/restore.js",    "restore.js",  "application/javascript" },
	{ "/crypto.js",     "crypto.js",   "application/javascript" },
	{ "/l2.js",         "l2.js",       "application/javascript" },
	{ "/tools.js",      "tools.js",    "application/javascript" },
	{ "/hostlink.js",   "hostlink.js", "application/javascript" },
	{ "/netaddr.js",    "netaddr.js",  "application/javascript" },
	{ "/wizard.js",     "wizard.js",   "application/javascript" },
	{ "/linkcheck.js",  "linkcheck.js", "application/javascript" },
	{ "/updates.js",    "updates.js",  "application/javascript" },
	{ 0, 0, 0 },
};

int serve_asset(int fd, const char *path)
{
	unsigned long i;

	for (i = 0; web_assets[i].url; i++) {
		if (!seq(path, web_assets[i].url))
			continue;
		/* The table's own literal, never the request. */
		serve_static(fd, web_assets[i].file, web_assets[i].ctype);
		return 1;
	}
	return 0;
}
