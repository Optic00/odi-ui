/*
 * Request dispatch, and the one route long enough to live beside it.
 */

#include "confd.h"
#include "buffers.h"
#include "http.h"
#include "mib.h"
#include "firmware.h"
#include "status.h"
#include "omci.h"
#include "routes.h"

/*
 * The management address and its netmask are one setting spread over two keys,
 * and network.sh judges them together at every boot: an address that is the
 * network or broadcast address of its mask is refused there and the stick
 * falls back to 192.168.1.1/24. So a write of either key is checked against
 * the other, from the same request when it carries it, else from the store,
 * else the /24 network.sh assumes for a missing netmask. NULL when fine.
 */
static const char *lan_pair_refusal(const char *name, const char *value,
				    const char *body)
{
	const char *other;
	char o[64];
	int is_addr;

	if (seq(name, "LAN_IP_ADDR"))
		other = "LAN_SUBNET", is_addr = 1;
	else if (seq(name, "LAN_SUBNET"))
		other = "LAN_IP_ADDR", is_addr = 0;
	else if (seq(name, "LAN_IP_ADDR2"))
		other = "LAN_SUBNET2", is_addr = 1;
	else if (seq(name, "LAN_SUBNET2"))
		other = "LAN_IP_ADDR2", is_addr = 0;
	else
		return 0;

	if (!form_get(body, other, o, sizeof(o)) && !read_key(other, o, sizeof(o)))
		o[0] = 0;
	if (is_addr) {
		if (!host_in_mask_ok(value, o[0] ? o : "255.255.255.0"))
			return "the network or broadcast address of the netmask, "
			       "which no host can use";
	} else if (o[0] && !host_in_mask_ok(o, value)) {
		return "a netmask that makes the management address its network "
		       "or broadcast address";
	}
	return 0;
}

/* A key's value as the next boot will read it: this request's, else the
 * store's, else `def`. */
static void effective(const char *body, const char *key, const char *def,
		      char *out, unsigned long cap)
{
	if (!form_get(body, key, out, cap) && !read_key(key, out, cap))
		str_copy(out, def, cap);
}

/* A dotted quad as a number. The callers have been through type_ok already,
 * or fall back to a default that parses. */
static unsigned long quad_num(const char *v)
{
	unsigned long n = 0, part = 0, i;

	for (i = 0;; i++) {
		if (v[i] >= '0' && v[i] <= '9') {
			part = part * 10 + (unsigned long)(v[i] - '0');
		} else {
			n = (n << 8) | (part & 255);
			part = 0;
			if (!v[i])
				break;
		}
	}
	return n & 0xffffffffUL;
}

/*
 * The gateways of LAN_ROUTES must lie inside a subnet the stick holds on its
 * management device: the primary address and netmask, or the second pair
 * while LAN_ENABLE_IP2 is 1. Judged from the address keys of this request, else
 * the store, else network.sh defaults (192.168.1.1, /24). The firmware turns
 * the whole key off on a gateway outside them, on the address of the stick,
 * or on a network or broadcast address, so the write is refused here.
 * NULL when fine.
 */
static const char *lan_routes_refusal(const char *value, const char *body)
{
	unsigned long gw[LAN_ROUTES_MAX], dest[LAN_ROUTES_MAX], plen[LAN_ROUTES_MAX];
	char ip1[64], m1[64], en[8], ip2[64], m2[64];
	unsigned long net1, mask1, net2 = 0, mask2 = 0;
	int n, i, have2;

	n = lan_routes_parse(value, dest, plen, gw);
	if (n <= 0)
		return 0;
	effective(body, "LAN_IP_ADDR", "192.168.1.1", ip1, sizeof(ip1));
	effective(body, "LAN_SUBNET", "255.255.255.0", m1, sizeof(m1));
	effective(body, "LAN_ENABLE_IP2", "0", en, sizeof(en));
	effective(body, "LAN_IP_ADDR2", "", ip2, sizeof(ip2));
	effective(body, "LAN_SUBNET2", "255.255.255.0", m2, sizeof(m2));
	if (!m1[0])
		str_copy(m1, "255.255.255.0", sizeof(m1));
	if (!m2[0])
		str_copy(m2, "255.255.255.0", sizeof(m2));
	if (!ip1[0])
		str_copy(ip1, "192.168.1.1", sizeof(ip1));
	mask1 = quad_num(m1);
	net1 = quad_num(ip1) & mask1;
	have2 = seq(en, "1") && ip2[0];
	if (have2) {
		mask2 = quad_num(m2);
		net2 = quad_num(ip2) & mask2;
	}
	for (i = 0; i < n; i++) {
		int ok1 = (gw[i] & mask1) == net1 && gw[i] != net1 &&
			  gw[i] != ((net1 | ~mask1) & 0xffffffffUL);
		int ok2 = have2 && (gw[i] & mask2) == net2 && gw[i] != net2 &&
			  gw[i] != ((net2 | ~mask2) & 0xffffffffUL);

		if (gw[i] == quad_num(ip1) || (have2 && gw[i] == quad_num(ip2)))
			return "a gateway is the address of the stick itself";
		if (ok1 || ok2)
			continue;
		return "a gateway is outside the management subnets (the first "
		       "address and netmask, or the second while it is on) or is the "
		       "network or broadcast address of one: the stick cannot use it";
	}
	return 0;
}

/*
 * Rules that name one key and a fact about another, which a type cannot say.
 * NULL when fine.
 *
 *  - OMCI_VEIP_SLOT_ID: omcid takes 2 to 254 and not 128, and logs "ignored"
 *    for anything else; meta.tsv's range cannot leave a hole in it.
 *  - The second management address must differ from the first while it is on:
 *    network.sh then refuses to add it twice, and says so only in a log. Judged
 *    from whichever of the three keys the request carries, else the store,
 *    else network.sh's defaults.
 */
static const char *key_refusal(const char *name, const char *value,
			       const char *body)
{
	char ip1[64], ip2[64], en[8];

	if (seq(name, "OMCI_VEIP_SLOT_ID")) {
		unsigned long n = 0, i;

		for (i = 0; value[i] >= '0' && value[i] <= '9'; i++)
			n = n * 10 + (unsigned long)(value[i] - '0');
		if (!value[i] && n == 128)
			return "slot 128 is not usable: omcid ignores it (2 to 254, not 128)";
		return 0;
	}
	if (seq(name, "LAN_ROUTES"))
		return lan_routes_refusal(value, body);
	if (!seq(name, "LAN_IP_ADDR") && !seq(name, "LAN_IP_ADDR2") &&
	    !seq(name, "LAN_ENABLE_IP2"))
		return 0;
	effective(body, "LAN_ENABLE_IP2", "0", en, sizeof(en));
	effective(body, "LAN_IP_ADDR", "192.168.1.1", ip1, sizeof(ip1));
	effective(body, "LAN_IP_ADDR2", "", ip2, sizeof(ip2));
	if (seq(en, "1") && ip2[0] && seq(ip1, ip2))
		return "the same as the other management address: the second "
		       "address would silently not be added";
	return 0;
}

/*
 * Stock keys that can be emptied. Empty is their default in the store
 * template: no LOID for an OLT that asks for none, no PLOAM password for one
 * that authenticates on the serial number alone. The odi-oss flash stores an
 * empty value for a stock key; the stock flash refuses it, and the failed
 * write says so. GPON_SN is not here: a stick without a serial does not
 * range. web/validate.js keeps the same list.
 */
static int empty_ok_key(const char *name)
{
	return seq(name, "LOID") || seq(name, "LOID_PASSWD") ||
	       seq(name, "LOID_OLD") || seq(name, "LOID_PASSWD_OLD") ||
	       seq(name, "GPON_PLOAM_PASSWD");
}

/*
 * The six keys of the management interface (confd.h, NETADDR_*), which a trial
 * writes and /api/config does not: the five of the address, and the static
 * routes beside them.
 */
static const char *const netaddr_keys[] = {
	"LAN_IP_ADDR", "LAN_SUBNET", "LAN_ENABLE_IP2", "LAN_IP_ADDR2", "LAN_SUBNET2",
	"LAN_ROUTES", 0
};

static int netaddr_key(const char *name)
{
	int i;

	for (i = 0; netaddr_keys[i]; i++)
		if (seq(name, netaddr_keys[i]))
			return 1;
	return 0;
}

/* Whether the address change goes through the trial: the image has the
 * script, and this is not a safe-mode boot. */
static int netaddr_trial(void)
{
	return file_exists(NETADDR_SCRIPT) && !file_exists(SAFEMODE_FLAG);
}

/* One end of a connection as dotted decimal in `out` (16 bytes at least):
 * the address the request was sent to (peer 0) or the client's (peer 1).
 * Empty when the kernel does not say or it is not IPv4. A struct sockaddr_in
 * on this big-endian target is the family in two bytes, the port in two, the
 * address in four. */
static void conn_addr(int conn, int peer, char *out)
{
	unsigned char sa[32];
	unsigned int len = sizeof(sa);
	unsigned long o = 0;
	int i;

	out[0] = 0;
	if (syscall3(peer ? __NR_getpeername : __NR_getsockname, conn, (long)sa,
		     (long)&len) < 0 || len < 8 || sa[0] != 0 || sa[1] != AF_INET)
		return;
	for (i = 0; i < 4; i++) {
		unsigned int v = sa[4 + i];

		if (v >= 100)
			out[o++] = (char)('0' + v / 100);
		if (v >= 10)
			out[o++] = (char)('0' + v / 10 % 10);
		out[o++] = (char)('0' + v % 10);
		if (i < 3)
			out[o++] = '.';
	}
	out[o] = 0;
}

/*
 * POST /api/config — write keys, one report line each.
 *
 * Nothing is applied implicitly. The response says which apply class the
 * changes need and the caller decides, because on this device a config write
 * does nothing until omci_app is restarted or the stick reboots, and pretending
 * otherwise is how you end up reading a stale command line and drawing the
 * wrong conclusion.
 */
static void handle_write(int conn, const char *body)
{
	char name[128], value[VALUE_MAX + 1], got[VALUE_MAX + 1], addr[160];
	char type[32], writable[32], apply[32];
	unsigned long i = 0;
	int first = 1, confirm = 0, wrote;
	int any_omci = 0, any_reboot = 0, any_untraced = 0, omci_interrupts = 0;
	int need_net = 0, any_stock = 0, need_syslog = 0, need_ntp = 0, need_igmp = 0, need_sfp = 0;

	if (read_file(SCHEMA_PATH_OVR, schema, sizeof(schema)) <= 0 &&
	    read_file(SCHEMA_PATH, schema, sizeof(schema)) <= 0) {
		respond(conn, "500 Internal Server Error", "application/json", 0);
		put_fd(conn, "{\"error\":\"no schema\"}");
		return;
	}

	/* meta.tsv carries the ranges and option lists; consumers.tsv carries
	 * the apply class derived from which binaries read the key. Both are
	 * optional -- a device without them validates by type alone and reports
	 * every write as untraced, which is the honest degraded answer. Both
	 * live in filebuf (buffers.h). */
	if (read_file(META_PATH_OVR, META_BUF, META_CAP) <= 0 &&
	    read_file(META_PATH, META_BUF, META_CAP) <= 0)
		META_BUF[0] = 0;
	/* settings.tsv, when the image has one, is the authority on what a
	 * write costs HERE: consumers.tsv was derived from the stock firmware,
	 * whose readers this image does not run. So consumers.tsv is only read
	 * without it. */
	if (read_file(SETT_PATH_OVR, sett, sizeof(sett)) <= 0 &&
	    read_file(SETT_PATH, sett, sizeof(sett)) <= 0)
		sett[0] = 0;
	CONS_BUF[0] = 0;
	if (!sett[0] &&
	    read_file(CONS_PATH_OVR, CONS_BUF, CONS_CAP) <= 0 &&
	    read_file(CONS_PATH, CONS_BUF, CONS_CAP) <= 0)
		CONS_BUF[0] = 0;

	/* Identity keys need saying so explicitly. Losing GPON_SN or MAC_KEY
	 * means the OLT stops authenticating the ONU, which is not something to
	 * do by mis-clicking. */
	{
		char c[16];
		unsigned long j = 0;

		while (body[j]) {
			unsigned long k = url_decode(body, j, '=', name, sizeof(name));

			if (!k)
				break;
			j = k;
			if (body[j] == '=')
				j++;
			/* Only _confirm is decoded: a long value of another key
			 * must not stop the scan before it gets there. */
			if (seq(name, "_confirm")) {
				j = url_decode(body, j, 0, c, sizeof(c));
				if (!j)
					break;
				if (seq(c, "identity"))
					confirm = 1;
			} else {
				j = url_skip(body, j);
			}
			if (body[j] == '&')
				j++;
		}
	}

	respond(conn, "200 OK", "application/json", 0);
	put_fd(conn, "{\"results\":[");

	while (body[i]) {
		unsigned long k = url_decode(body, i, '=', name, sizeof(name));
		const char *err = 0;

		if (!k) {
			/* A name that does not fit or is badly encoded ends the
			 * batch, and says so rather than ending it silently. */
			put_fd(conn, first ? "" : ",");
			first = 0;
			put_fd(conn, "{\"name\":\"\",\"ok\":false,\"error\":"
				     "\"a field name is too long or badly encoded\"}");
			break;
		}
		i = k;
		if (body[i] == '=')
			i++;
		i = url_decode(body, i, 0, value, sizeof(value));
		if (!i) {
			/* Not cut to fit: a value the page did not send would be
			 * written and read back as if it had been. */
			put_fd(conn, first ? "" : ",");
			first = 0;
			put_fd(conn, "{\"name\":\"");
			put_json_cstr(conn, name);
			put_fd(conn, "\",\"ok\":false,\"error\":\"the value is too long "
				     "or badly encoded; this key was not written\"}");
			break;
		}

		if (seq(name, "_confirm"))
			goto next;

		if (refused_key(name))
			err = "refused: a wrong SerDes mode costs every management path";
		else if (!schema_lookup(schema, name, addr, sizeof(addr),
					type, sizeof(type),
					writable, sizeof(writable), apply, sizeof(apply)))
			err = "not in the schema";
		/* An allowlist, not a denylist. "never" was the only value
		 * refused, so an empty or misspelt column -- from a short row,
		 * or a hand edit of the device's own keys.tsv -- read as
		 * writable. Only the two values that mean writable are. */
		else if (!seq(writable, "yes") && !seq(writable, "identity"))
			err = "not writable";
		else if (seq(writable, "identity") && !confirm)
			err = "identity key: resend with _confirm=identity";
		/* A trial value must not reach the store before it was seen to
		 * answer: mgmt-addr.sh try applies it, its confirm stores it. */
		else if (netaddr_key(name) && netaddr_trial())
			err = "a management address is changed through the address trial "
			      "(POST /api/netaddr), which stores it only when confirmed "
			      "over the new address";
		/* Only the odi-only hostport, ascii14, fixedme and routes keys
		 * (SYSLOG_SERVER, NTP_SERVER, ONU_HW_VERSION, OMCI_FIXED_ME,
		 * LAN_ROUTES)
		 * can be cleared: odi-oss flash keeps them in a plain file and
		 * an empty value removes the key. Stock keys live in the vendor
		 * XML, where an empty value is not a clear. The one exception
		 * is fwdop (RTK_DEVINFO_SPECVER): empty is its off state, on
		 * both firmwares, and is what the stock page stores to reset.
		 * The LOID and PLOAM password keys (empty_ok_key) are stock
		 * keys whose empty value is their stock default. */
		else if (!value[0] && !seq(type, "hostport") && !seq(type, "ascii14") &&
			 !seq(type, "fixedme") && !seq(type, "fwdop") &&
			 !seq(type, "routes") && !empty_ok_key(name))
			err = "cannot be cleared: this key needs a value";
		else if (!(empty_ok_key(name) && !value[0]) && !type_ok(type, value))
			err = "not valid for its type";
		else if ((err = lan_pair_refusal(name, value, body)))
			;
		else if ((err = key_refusal(name, value, body)))
			;
		else
			meta_ok(name, value, &err);   /* sets err, or clears it */

		if (!first)
			put_fd(conn, ",");
		first = 0;
		put_fd(conn, "{\"name\":\"");
		put_json_cstr(conn, name);
		put_fd(conn, "\",");

		if (err) {
			put_fd(conn, "\"ok\":false,\"error\":\"");
			put_json_cstr(conn, err);
			put_fd(conn, "\"}");
			goto next;
		}

		wrote = write_key(addr, value, got, sizeof(got));
		if (wrote > 0) {
			put_fd(conn, "\"ok\":true,\"value\":\"");
			put_json_cstr(conn, got);
			put_fd(conn, "\"}");
			/*
			 * consumers.tsv is authoritative where it has a row --
			 * it is derived from which binaries actually read the
			 * key -- and the schema's own column is the fallback.
			 * The comment here used to say exactly that while the
			 * code read neither: it lumped everything that was not
			 * literally restart:omci into "reboot", so a key marked
			 * immediate still told the user to reboot, and the page
			 * could show "no reboot" in the table and demand one on
			 * save.
			 */
			{
				char derived[32];
				const char *a = apply;

				if (sett[0]) {
					/* Column 2 is the action. A key the
					 * table does not name is read by
					 * nothing on this image: it changes
					 * the stock slot, and costs nothing
					 * here. */
					if (!tsv_field(sett, name, 2, derived, sizeof(derived)))
						any_stock = 1;
					else if (seq(derived, "network"))
						need_net = 1;
					else if (seq(derived, "syslog"))
						need_syslog = 1;
					else if (seq(derived, "ntp"))
						need_ntp = 1;
					else if (seq(derived, "igmp"))
						need_igmp = 1;
					else if (seq(derived, "sfp"))
						need_sfp = 1;
					else if (seq(derived, "omci")) {
						char cls[16];

						any_omci = 1;
						/* omcid reloads on SIGHUP: a key of class
						 * live is rebuilt in place and costs
						 * nothing, any other class re-registers
						 * the ONU. The page applies the first
						 * straight away and asks before the
						 * second. */
						if (!tsv_field(sett, name, 1, cls, sizeof(cls)) ||
						    !seq(cls, "live"))
							omci_interrupts = 1;
					}
					/* "none": read by the daemon each time it
					 * is used, nothing to run. */
					else if (seq(derived, "reboot"))
						any_reboot = 1;
				} else {
					if (tsv_field(CONS_BUF, name, 1, derived, sizeof(derived)) &&
					    derived[0] && !seq(derived, "unknown"))
						a = derived;

					if (seq(a, "restart:omci"))
						any_omci = 1;
					else if (seq(a, "reboot"))
						any_reboot = 1;
					else if (seq(a, "immediate"))
						;              /* already in effect */
					else
						any_untraced = 1;
				}
			}
		} else if (wrote < 0) {
			/* flash failed or printed no KEY=value line: there is
			 * no read-back to quote, and got holds why instead. */
			put_fd(conn, "\"ok\":false,\"error\":\"");
			put_json_cstr(conn, got);
			put_fd(conn, "\"}");
		} else {
			/* The write reported success and the value did not
			 * change. This is why every write is read back. */
			put_fd(conn, "\"ok\":false,\"error\":\"did not stick, device holds '");
			put_json_cstr(conn, got);
			put_fd(conn, "'\"}");
		}
next:
		if (body[i] == '&')
			i++;
	}

	/*
	 * The strongest class in the batch wins, and "untraced" is reported
	 * separately from "reboot". They need different words: one is "this key
	 * is known to need a reboot", the other is "nothing in the image was
	 * seen reading this key, so assume the worst" -- and 159 of the 184 keys
	 * are in the second group.
	 */
	put_fd(conn, "],\"apply\":\"");
	if (any_reboot || any_untraced)
		put_fd(conn, "reboot");
	else if (any_omci)
		put_fd(conn, "restart:omci");
	else
		put_fd(conn, "none");
	put_fd(conn, "\",\"untraced\":");
	put_fd(conn, (any_untraced && !any_reboot) ? "true" : "false");
	/*
	 * What applying the batch takes, one entry per action, for an image
	 * with a settings table: "network" (live, apply.sh network), "omci"
	 * (interrupts internet, apply.sh omci), "reboot". `stock` says some of
	 * the keys are read by nothing here. The page runs or offers each; this
	 * route applies nothing itself.
	 */
	put_fd(conn, ",\"needs\":[");
	{
		int first_need = 1;

		if (need_net) {
			put_fd(conn, "\"network\"");
			first_need = 0;
		}
		if (need_syslog) {
			put_fd(conn, first_need ? "\"syslog\"" : ",\"syslog\"");
			first_need = 0;
		}
		if (need_ntp) {
			put_fd(conn, first_need ? "\"ntp\"" : ",\"ntp\"");
			first_need = 0;
		}
		if (need_igmp) {
			put_fd(conn, first_need ? "\"igmp\"" : ",\"igmp\"");
			first_need = 0;
		}
		if (need_sfp) {
			put_fd(conn, first_need ? "\"sfp\"" : ",\"sfp\"");
			first_need = 0;
		}
		if (any_omci && sett[0]) {
			put_fd(conn, first_need ? "\"omci\"" : ",\"omci\"");
			first_need = 0;
		}
		if (any_reboot && sett[0])
			put_fd(conn, first_need ? "\"reboot\"" : ",\"reboot\"");
	}
	put_fd(conn, "],\"stock\":");
	put_fd(conn, any_stock ? "true" : "false");
	/* Whether the omci action drops the fibre service: false when every key
	 * of the batch that needs it is class live (omcid rebuilds in place). */
	put_fd(conn, ",\"interrupts\":");
	put_fd(conn, omci_interrupts ? "true" : "false");
	put_fd(conn, "}");
}

/*
 * The shape of one OpenSSH public key line, as `ssh-keygen` prints it:
 * TYPE BLOB [COMMENT]. NULL when it is one, else what is wrong, in words that
 * say what is allowed. The page makes the same checks (web/validate.js,
 * sshKeyProblem); `existing` is the file as it is now, for the duplicate.
 *
 * What it proves: the type is one dropbear takes, the blob is whole base64
 * (a multiple of four, padding only at the end, as long as the shortest real
 * key), and the blob names the same type inside itself, which a private key,
 * a fingerprint or a half-pasted line never does. What it cannot prove is
 * that the key bytes are good: dropbear decides that at login.
 */
static const char *const sshkey_types[] = {
	"ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384",
	"ecdsa-sha2-nistp521", "sk-ssh-ed25519@openssh.com",
	"sk-ecdsa-sha2-nistp256@openssh.com", 0
};

static const char *sshkey_refusal(const char *key, const char *existing)
{
	static const char shape[] = "not an OpenSSH public key line: paste the whole "
		"contents of the .pub file, TYPE BLOB and an optional comment, one line "
		"(ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256/384/521 or an sk- type)";
	unsigned long t = 0, b, e, i, k, tl;
	const char *type = 0;

	for (i = 0; key[i]; i++)
		if ((unsigned char)key[i] < 32 || (unsigned char)key[i] > 126)
			return "a key is one line of printable text; remove the line "
			       "breaks and anything that is not plain text";
	while (key[t] && key[t] != ' ')
		t++;
	for (k = 0; sshkey_types[k]; k++) {
		tl = str_len(sshkey_types[k]);
		if (tl == t && spre(key, sshkey_types[k]))
			type = sshkey_types[k];
	}
	if (!type || key[t] != ' ')
		return shape;
	tl = t;
	b = t + 1;
	for (e = b; key[e] && key[e] != ' '; e++) {
		if (b64val(key[e]) < 0 && key[e] != '=')
			return shape;
	}
	if (e - b < 68 || (e - b) % 4)
		return shape;
	for (k = b; k < e; k++)
		if (key[k] == '=' && (e - k > 2 || key[e - 1] != '='))
			return shape;
	/* The blob is a run of length-prefixed strings (RFC 4253, section 6.6):
	 * the type name first, then the key material. Decoded and walked to its
	 * end, it must name the type it was declared with and add up exactly, so
	 * a truncated paste, a private key or a fingerprint cannot pass. */
	{
		char raw[1024];
		long rn = b64decode(key + b, e - b, raw, sizeof(raw));
		unsigned long pos = 0, fields = 0;

		if (rn < 0)
			return shape;
		while (pos < (unsigned long)rn) {
			unsigned long l;

			if (pos + 4 > (unsigned long)rn)
				return shape;
			l = ((unsigned long)(unsigned char)raw[pos] << 24) |
			    ((unsigned long)(unsigned char)raw[pos + 1] << 16) |
			    ((unsigned long)(unsigned char)raw[pos + 2] << 8) |
			    (unsigned long)(unsigned char)raw[pos + 3];
			pos += 4;
			if (!l || l > (unsigned long)rn - pos)
				return shape;
			if (!fields) {
				if (l != tl)
					return shape;
				for (k = 0; k < tl; k++)
					if (raw[pos + k] != key[k])
						return "the key says one type outside and another inside; "
						       "paste the line as ssh-keygen printed it";
			}
			pos += l;
			fields++;
		}
		if (fields < 2)
			return shape;
	}
	/* Already there: the same type and blob on a line of the file. */
	for (i = 0; existing[i]; ) {
		unsigned long ls = i, le = i;

		while (existing[le] && existing[le] != '\n')
			le++;
		if (le - ls >= e - b + tl + 1 &&
		    spre(existing + ls, type) && existing[ls + tl] == ' ') {
			for (k = 0; k < e - b && existing[ls + tl + 1 + k] == key[b + k]; k++)
				;
			if (k == e - b && (existing[ls + tl + 1 + k] == ' ' ||
					   ls + tl + 1 + k == le))
				return "that key is already in the list";
		}
		i = existing[le] ? le + 1 : le;
	}
	return 0;
}

/*
 * Whether the file just uploaded starts like a tar archive: a 512-byte header
 * whose magic field (offset 257) reads "ustar", which both the POSIX and the
 * GNU formats carry. An image is a tarball (fwu_starter.sh extracts fwu.sh and
 * md5.txt from it), and a file that is not one used to be kept in /tmp until
 * Write failed with "is it an image tarball?" a click later. This proves the
 * format, not the contents: fwu.sh checks those before it erases anything.
 */
/*
 * The md5 of the image the last upload left in UPLOAD_PATH, as /api/upload
 * answered it, or "" when there is none this daemon vouches for: cleared when
 * an upload starts, set only when one completes. A write names the md5 it
 * means, so a tab cannot flash what another tab, or an scp, put in the file
 * after it uploaded. One file, one md5: a second upload replaces both.
 */
static char upload_md5[33];

static int upload_is_tar(void)
{
	char head[520];
	long n = read_file(UPLOAD_PATH, head, 513);

	return n >= 512 && head[0] &&
	       head[257] == 'u' && head[258] == 's' && head[259] == 't' &&
	       head[260] == 'a' && head[261] == 'r';
}

/*
 * The ntpd hook leaves /tmp/ntp-status as five key=value lines (event, time,
 * offset, stratum, last_sync). The file is the image's, not ours to trust:
 * only those keys are passed on, and a value goes out only if it is short
 * and made of digits, '.' and '-' (an empty one stays empty); the event must
 * be one of the four known words. Anything else becomes "", so the file can
 * never put arbitrary text into the answer. Returns 0, and writes nothing,
 * when the file is absent or names no known event.
 */
static int emit_ntp_status(int conn)
{
	static const char *const keys[] = { "event", "time", "offset", "stratum", "last_sync" };
	static const char *const events[] = { "unsync", "step", "stratum", "periodic" };
	char buf[256], val[5][24];
	unsigned long i = 0, k, j;
	int seen_event = 0;
	long got = read_file(NTP_STATUS_FILE, buf, sizeof(buf));

	if (got <= 0)
		return 0;
	for (k = 0; k < 5; k++)
		val[k][0] = 0;
	while (buf[i]) {
		unsigned long ls = i, le = i, eq;

		while (buf[le] && buf[le] != '\n')
			le++;
		eq = ls;
		while (eq < le && buf[eq] != '=')
			eq++;
		if (eq < le) {
			for (k = 0; k < 5; k++) {
				unsigned long n = eq - ls;

				if (slen(keys[k]) != n)
					continue;
				for (j = 0; j < n && buf[ls + j] == keys[k][j]; j++)
					;
				if (j != n)
					continue;
				n = le - eq - 1;
				if (n < sizeof(val[k])) {
					for (j = 0; j < n; j++)
						val[k][j] = buf[eq + 1 + j];
					val[k][n] = 0;
				}
			}
		}
		i = buf[le] ? le + 1 : le;
	}
	for (k = 0; k < 4; k++)
		if (seq(val[0], events[k]))
			seen_event = 1;
	if (!seen_event)
		return 0;
	put_fd(conn, "{");
	for (k = 0; k < 5; k++) {
		int good = 1;

		if (k)
			put_fd(conn, ",");
		put_fd(conn, "\"");
		put_fd(conn, keys[k]);
		put_fd(conn, "\":\"");
		if (k > 0)
			for (j = 0; val[k][j]; j++)
				if (!((val[k][j] >= '0' && val[k][j] <= '9')
				      || val[k][j] == '.' || val[k][j] == '-'))
					good = 0;
		if (good)
			put_fd(conn, val[k]);
		put_fd(conn, "\"");
	}
	put_fd(conn, "}");
	return 1;
}

/*
 * The routes that answer before a credential is asked for: the sign-in page
 * and what it loads, the sign-in itself, and sign-out. Returns 1 when it
 * answered. Runs after request_refusal(), so a rebound DNS name gets none of
 * them either, and before request_path(), so it reads the request as it came.
 */
static int serve_public(int conn, unsigned long body_have, unsigned long body_want)
{
	char target[32];

	if (!request_target(req, target, sizeof(target)))
		return 0;

	if (spre(req, "GET ") &&
	    (seq(target, "/login") || seq(target, "/login.js") || seq(target, "/style.css"))) {
		/* Signed in already: nothing to do there. */
		if (seq(target, "/login") && authorised(req) == AUTH_SESSION) {
			respond(conn, "303 See Other", "text/plain", "Location: /\r\n");
			return 1;
		}
		return serve_asset(conn, target);
	}

	/*
	 * Sign in: the credential, once, for a session cookie.
	 *
	 * The page posts it with fetch(), which sends the real Origin, so a
	 * foreign page is refused here like any other cross-site write. A wrong
	 * credential costs the same second as a wrong Basic header.
	 */
	if (seq(target, "/api/login") && spre(req, "POST ")) {
		char user[256], pass[512], tok[33], cookie[128];
		char *body = request_body(req);
		unsigned long k;
		int ok;

		if (body_want && body_have < body_want) {
			respond(conn, "413 Payload Too Large", "text/plain", 0);
			put_fd(conn, "request too large\n");
			return 1;
		}
		if (!same_origin(req)) {
			respond(conn, "403 Forbidden", "text/plain", 0);
			put_fd(conn, "cross-site request refused\n");
			return 1;
		}
		ok = form_get(body, "user", user, sizeof(user)) &&
		     form_get(body, "password", pass, sizeof(pass)) &&
		     credential_matches(user, pass);
		for (k = 0; k < sizeof(pass); k++)
			((volatile char *)pass)[k] = 0;
		for (k = 0; body[k]; k++)
			((volatile char *)body)[k] = 0;
		if (!ok) {
			sleep_s(1);
			respond(conn, "401 Unauthorized", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"wrong username or password\"}");
			return 1;
		}
		if (!session_start(tok)) {
			respond(conn, "500 Internal Server Error", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"could not start a session: "
				     "no random bytes from " RANDOM_PATH "\"}");
			return 1;
		}
		str_copy(cookie, "Set-Cookie: " SESSION_COOKIE "=", sizeof(cookie));
		str_copy(cookie + slen(cookie), tok, sizeof(cookie) - slen(cookie));
		str_copy(cookie + slen(cookie), "; Path=/; HttpOnly; SameSite=Strict\r\n",
			 sizeof(cookie) - slen(cookie));
		respond(conn, "200 OK", "application/json", cookie);
		put_fd(conn, "{\"ok\":true}");
		return 1;
	}

	/*
	 * Sign out, any method, signed in or not: there is nothing to protect.
	 *
	 * The page posts it as a plain form, and under this daemon's
	 * `Referrer-Policy: no-referrer` a Chromium form POST carries
	 * `Origin: null`, so it is not held to the cross-site check: a foreign
	 * page that signs the operator out costs them a sign-in, nothing more.
	 *
	 * A session is deleted, which ends it for certain, and the browser is
	 * sent to the sign-in page. A request that carries no session but a
	 * Basic header gets what sign-out used to be: a 401 with a fresh
	 * challenge, so a browser that cached the password drops it.
	 */
	if (seq(target, "/api/logout")) {
		if (authorised(req) != AUTH_SESSION &&
		    header_copy(req, "authorization", hdrbuf, sizeof(hdrbuf))) {
			respond(conn, "401 Unauthorized", "text/html",
				"WWW-Authenticate: Basic realm=\"odi-ui\"\r\n");
			put_fd(conn,
			       "<!doctype html><meta charset=utf-8>"
			       "<title>Signed out</title>"
			       "<body style=\"font:14px system-ui;padding:2rem\">"
			       "<h1>Signed out</h1>"
			       "<p>Close this tab to be sure the credential is gone. "
			       "<a href=\"/login\">Sign in again</a>.</body>");
			return 1;
		}
		session_end_current(req);
		respond(conn, "303 See Other", "text/plain",
			"Location: /login?out=1\r\n"
			"Set-Cookie: " SESSION_COOKIE "=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict\r\n");
		put_fd(conn, "signed out\n");
		return 1;
	}
	return 0;
}

/*
 * The image files the page reads, one row per route: /api/<name> answers the
 * file as JSON rows with these columns, and /api/static gathers them all. Each
 * is read from the /etc/config override when there is one.
 */
static const char *col_schema[] = { "name", "store", "address", "section",
				    "type", "apply", "writable", "common" };
static const char *col_meta[] = { "name", "label", "help", "options",
				  "depends", "range" };
static const char *col_cons[] = { "name", "apply", "readers" };
static const char *col_sett[] = { "name", "apply", "action", "pair", "reader",
				  "note", "unset" };
static const char *col_feat[] = { "mask", "bit", "feature", "module" };
static const char *col_base[] = { "name", "value" };

struct tsv_route {
	const char *name;
	const char *ovr, *path;
	char *buf;
	unsigned long cap;
	const char **col;
	unsigned long ncol;
	int required;
};

static const struct tsv_route tsv_routes[] = {
	/* The keys the page can show and change. Without it there is no page. */
	{ "schema", SCHEMA_PATH_OVR, SCHEMA_PATH, schema, sizeof(schema), col_schema, 8, 1 },
	/* Curated help, hand-written and merged with the schema by the
	 * browser. Absent is not an error: the UI degrades to bare key names
	 * rather than refusing to load. */
	{ "meta", META_PATH_OVR, META_PATH, schema, sizeof(schema), col_meta, 6, 0 },
	/* Derived from the firmware by scripts/classify-apply.py: which
	 * programs read each key, and therefore what it costs to change one.
	 * Absent degrades to the schema's own apply column. */
	{ "consumers", CONS_PATH_OVR, CONS_PATH, schema, sizeof(schema), col_cons, 3, 0 },
	/* This image's own view of each key. Absent answers an empty list, and
	 * the page then offers every key as it used to. */
	{ "settings", SETT_PATH_OVR, SETT_PATH, sett, sizeof(sett), col_sett, 7, 0 },
	/* The OMCI_CUSTOM_* bitmasks, decoded. Absent degrades to showing the
	 * raw value, which is what every other tool for this device does. */
	{ "features", FEAT_PATH_OVR, FEAT_PATH, schema, sizeof(schema), col_feat, 4, 0 },
	{ "baseline", BASE_PATH_OVR, BASE_PATH, schema, sizeof(schema), col_base, 2, 0 },
};
#define TSV_ROUTES (sizeof(tsv_routes) / sizeof(tsv_routes[0]))

static const struct tsv_route *tsv_route_for(const char *path)
{
	unsigned long i;

	if (!spre(path, "/api/"))
		return 0;
	for (i = 0; i < TSV_ROUTES; i++)
		if (seq(path + 5, tsv_routes[i].name))
			return &tsv_routes[i];
	return 0;
}

/* Read a row's file into its buffer. Returns its length, or -1 when neither
 * the override nor the image file is there. */
static long tsv_load(const struct tsv_route *t)
{
	if (read_file(t->ovr, t->buf, t->cap) <= 0 &&
	    read_file(t->path, t->buf, t->cap) <= 0)
		return -1;
	return (long)slen(t->buf);
}

/*
 * The image defaults, both stores, into `values`. Both files are small -- ten
 * values between them -- so one buffer and the values parser already written
 * cover it.
 *
 * Clear it FIRST. read_file returns without touching the buffer when open()
 * fails, and `values` is the same buffer /api/values fills. A device missing
 * both default files therefore served the previous /api/values response back
 * as the image defaults, and the page labelled every key on it an image
 * default -- the exact inversion of what it is for, and it suppressed the
 * baseline "changed" labels too.
 */
static long load_defaults(void)
{
	long n, m;

	values[0] = 0;
	n = read_file(DEFAULT_CS, values, sizeof(values));
	if (n < 0)
		n = 0;
	values[n] = 0;
	m = read_file(DEFAULT_HS, values + n, sizeof(values) - (unsigned long)n);
	if (m < 0)
		m = 0;
	values[n + m] = 0;
	return n + m;
}

/*
 * A record of key=value lines as a JSON object, or null when the file is not
 * there: the safe-mode flag and record, and the record of a recreated config
 * store. An empty file is an empty object, which is still a record.
 */
static void emit_record(int conn, const char *file, char *buf, unsigned long cap)
{
	long got = read_file(file, buf, cap);

	if (got < 0) {
		put_fd(conn, "null");
		return;
	}
	put_fd(conn, "{");
	if (got > 0)
		put_kv_members(conn, buf);
	put_fd(conn, "}");
}

/*
 * GET /api/hostlink without its response head: /api/init carries it too.
 */
static void emit_hostlink_body(int conn)
{
	char buf[1024];
	long got;

	put_fd(conn, "{\"supported\":");
	put_fd(conn, file_exists(HOSTLINK_SCRIPT) ? "true" : "false");
	put_fd(conn, ",\"state\":{");
	got = read_file(HOSTLINK_STATE, buf, sizeof(buf));
	if (got > 0)
		put_kv_members(conn, buf);
	put_fd(conn, "},\"serdes\":{\"supported\":");
	put_fd(conn, file_exists(SERDES_SCRIPT) ? "true" : "false");
	put_fd(conn, ",\"state\":{");
	got = read_file(SERDES_STATE, buf, sizeof(buf));
	if (got > 0)
		put_kv_members(conn, buf);
	put_fd(conn, "}},\"safemode_now\":");
	emit_record(conn, SAFEMODE_FLAG, buf, sizeof(buf));
	put_fd(conn, ",\"safemode\":");
	emit_record(conn, HOSTLINK_SAFEMODE, buf, sizeof(buf));
	put_fd(conn, ",\"reseed\":");
	emit_record(conn, RESEED_RECORD, buf, sizeof(buf));
	put_fd(conn, ",\"link\":\"");
	got = read_file(HOSTLINK_LINK, buf, sizeof(buf));
	if (got > 0 && (buf[0] == '0' || buf[0] == '1'))
		put_json_str(conn, buf, 1);
	/* The login the flag stands for, as the request path judges it. */
	put_fd(conn, "\",\"safe_login\":\"");
	put_fd(conn, safemode_login_name());
	put_fd(conn, "\",\"uptime\":\"");
	got = read_file(UPTIME_FILE, buf, sizeof(buf));
	if (got > 0) {
		unsigned long k = 0;

		while (buf[k] >= '0' && buf[k] <= '9')
			k++;
		put_json_str(conn, buf, k);
	}
	put_fd(conn, "\"}");
}

void serve(int conn)
{
	char *path, *method, *body, *query;
	unsigned long body_have = 0, body_want = 0;
	long n;

	n = read_request(conn, req, sizeof(req), &body_have, &body_want);
	if (n == REQ_TOO_LARGE) {
		respond(conn, "413 Payload Too Large", "text/plain", 0);
		put_fd(conn, "request too large\n");
		return;
	}
	if (n <= 0)
		return;
	note_cache_request(req);

	/*
	 * Which name and which kind of caller, before anything else: a rebound
	 * DNS name or a foreign page gets no 401 prompt and no work done. Before
	 * request_path() for the usual reason, it reads headers.
	 */
	{
		const char *why = request_refusal(req);

		if (why) {
			respond(conn, "403 Forbidden", "text/plain", 0);
			put_fd(conn, why);
			return;
		}
	}

	if (serve_public(conn, body_have, body_want))
		return;

	/* Authenticate BEFORE parsing, not after: request_path() NUL-terminates
	 * the method and the path in place, and the first of those NULs stops
	 * any later scan for a header dead. That cost an hour of a correct
	 * password being rejected. */
	if (!authorised(req)) {
		int basic = header_copy(req, "authorization", hdrbuf, sizeof(hdrbuf));

		/*
		 * Sleep before answering a wrong password. There is no lockout,
		 * so without this the only limit on guessing is how fast the
		 * device can answer -- measured at 319 attempts/sec, which is
		 * plenty to walk a human-chosen password.
		 *
		 * This server is single-threaded and serial, which turns a
		 * modest delay into a hard global rate limit: the sleep blocks
		 * every other request too, so an attacker cannot open more
		 * connections to go faster. It costs a legitimate typo one
		 * second. A request that offered no credential guessed nothing
		 * and is answered at once.
		 */
		if (basic)
			sleep_s(1);
		/* A browser opening a page goes to the sign-in page. */
		if (spre(req, "GET ") && header_has(req, "accept", "text/html")) {
			respond(conn, "303 See Other", "text/plain", "Location: /login\r\n");
			put_fd(conn, "sign in at /login\n");
			return;
		}
		/*
		 * The Basic challenge only to a client that is speaking Basic.
		 * Sent to the page, it makes the browser open its own password
		 * dialog over the sign-in page: a fetch that finds the session
		 * gone gets a bare 401, and the page goes to /login itself.
		 */
		respond(conn, "401 Unauthorized", "text/plain",
			basic ? "WWW-Authenticate: Basic realm=\"odi-ui\"\r\n" : 0);
		put_fd(conn, "authentication required\n");
		return;
	}

	/* Grab the body BEFORE parsing the request line: request_path()
	 * NUL-terminates the method in place and the first of those NULs would
	 * stop the scan for the header/body boundary dead. Same for the CSRF
	 * check, which reads the Origin and Host headers. */
	body = request_body(req);
	{
		int cross = !same_origin(req);

		path = request_path(req, &method);
		if (!path) {
			respond(conn, "400 Bad Request", "text/plain", 0);
			return;
		}
		/*
		 * Split the query off the path, once, here. Every route below
		 * compares the path with seq(), so before this a single `?`
		 * would have made `/api/status?x=1` a 404 -- and the read
		 * routes that take arguments need the query anyway. It is
		 * urlencoded exactly like a form body, so form_get reads it.
		 */
		query = "";
		{
			unsigned long q = 0;

			while (path[q] && path[q] != '?')
				q++;
			if (path[q] == '?') {
				path[q] = 0;
				query = path + q + 1;
			}
		}
		if (cross && !seq(method, "GET")) {
			respond(conn, "403 Forbidden", "text/plain", 0);
			put_fd(conn, "cross-site request refused\n");
			return;
		}
	}

	/*
	 * The firmware upload, and the only route that reads past the request
	 * buffer.
	 *
	 * It is placed here on purpose: after authentication and after the
	 * cross-site check, so nothing unauthenticated can make this device
	 * write 3 MB into the ramfs every other process shares. The body is
	 * streamed straight to a file in 64 KB pieces and is never held whole
	 * in memory -- which is what the Firmware tab used to say could not be
	 * done, and the reason it handed out an scp command instead.
	 *
	 * Raw bytes, not multipart. `fetch(url, {body: file})` sends the file
	 * as the body with no boundary to find, so there is no parser here to
	 * get wrong.
	 */
	if (seq(path, "/api/upload") && seq(method, "POST")) {
		long fd, wrote = 0;
		unsigned long left;
		unsigned long t_up;

		if (!body_want || body_want > UPLOAD_MAX) {
			respond(conn, "413 Payload Too Large", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"an image is a few MB; this was not\"}");
			return;
		}

		/* The flasher is reading that very file. */
		if (fwu_running()) {
			respond(conn, "409 Conflict", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"a firmware write is running; "
				     "wait for it to finish before uploading another image\"}");
			return;
		}

		/*
		 * Bytes beyond the declared length are not part of this body (a
		 * client that pipelines, or lies): without the clamp `left`
		 * below is a subtraction that wraps to about four billion and
		 * the loop copies whatever the peer sends until /tmp is full.
		 */
		if (body_have > body_want)
			body_have = body_want;

		/*
		 * A fresh file, never one reached through a link: /tmp is shared,
		 * and O_CREAT|O_TRUNC on a name somebody else made would write
		 * the image wherever it points. Unlinking first and creating
		 * with O_EXCL (which does not follow a link) makes the name this
		 * daemon's own or the open fails.
		 */
		upload_md5[0] = 0;
		syscall3(__NR_unlink, (long)SSH_IMG_PATH, 0, 0);
		syscall3(__NR_unlink, (long)UPLOAD_PATH, 0, 0);
		fd = syscall3(__NR_open, (long)UPLOAD_PATH,
			      O_WRONLY | O_CREAT | O_EXCL, 0600);
		if (fd < 0) {
			respond(conn, "500 Internal Server Error", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"could not open " UPLOAD_PATH "\"}");
			return;
		}

		/* What already arrived with the headers, then the rest. */
		if (body_have && write_all((int)fd, body, body_have) < 0)
			wrote = -1;
		else
			wrote = (long)body_have;

		left = body_want - body_have;
		t_up = mono_ms();
		while (wrote >= 0 && left) {
			unsigned long chunk = left < sizeof(filebuf) ? left : sizeof(filebuf);
			long got, budget = UPLOAD_DEADLINE_MS - (long)(mono_ms() - t_up);

			/* SO_RCVTIMEO bounds one read, so a peer sending a byte
			 * now and then never trips it: the whole body has a
			 * budget, and the wait for each piece is part of it. */
			if (budget <= 0 || !wait_readable(conn, budget)) {
				wrote = -1;
				break;
			}
			got = syscall3(__NR_read, conn, (long)filebuf, (long)chunk);
			if (got <= 0) { wrote = -1; break; }
			if (write_all((int)fd, filebuf, (unsigned long)got) < 0) {
				/* /tmp is ramfs and shared. A short write here
				 * is the filesystem filling up, and leaving a
				 * half-image behind would fill it further. */
				wrote = -1;
				break;
			}
			wrote += got;
			left -= (unsigned long)got;
		}
		syscall3(__NR_close, fd, 0, 0);

		if (wrote < 0 || (unsigned long)wrote != body_want) {
			syscall3(__NR_unlink, (long)UPLOAD_PATH, 0, 0);
			respond(conn, "500 Internal Server Error", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"the upload did not complete; "
				     "the partial file has been removed\"}");
			return;
		}

		if (!upload_is_tar()) {
			syscall3(__NR_unlink, (long)UPLOAD_PATH, 0, 0);
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"that is not a tar archive; "
				     "an image is the .tar that make image builds\"}");
			return;
		}

		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"ok\":true,\"bytes\":");
		put_u32_fd(conn, (unsigned long)wrote);
		/* The device's own md5, so it can be compared with the one
		 * beside the image you built. fwu.sh checks the kernel and
		 * rootfs md5s from inside the tar before it erases anything,
		 * so this is about the transfer, not the contents. */
		{
			static char *const argv[] = { "md5sum", UPLOAD_PATH, 0 };
			char out[128];
			unsigned long i = 0;

			put_fd(conn, ",\"md5\":\"");
			if (run_to_buf(MD5SUM_PATH, argv, out, sizeof(out),
				       MD5SUM_TIMEOUT_MS) > 0) {
				while (out[i] && out[i] != ' ' && out[i] != '\n')
					i++;
				put_json_str(conn, out, i);
				/* Only a whole md5 binds a write: a hash that
				 * could not be taken leaves nothing to match,
				 * and Write then asks for the upload again. */
				if (i == 32) {
					unsigned long k;

					for (k = 0; k < 32; k++)
						upload_md5[k] = out[k];
					upload_md5[32] = 0;
				}
			}
			put_fd(conn, "\"}");
		}
		return;
	}

	/*
	 * Every other route wants its body whole. Before the upload existed
	 * read_request refused an oversized one itself; now it reports one, and
	 * this is where that becomes the same 413 it always was.
	 */
	if (body_want && body_have < body_want) {
		respond(conn, "413 Payload Too Large", "text/plain", 0);
		put_fd(conn, "request too large\n");
		return;
	}

	/*
	 * Set the config UI's own credential, creating the file if it is not
	 * there.
	 *
	 * This is the way out of the built-in default, and it has to be here
	 * rather than only in a runbook: the state it fixes is the state of
	 * every factory-reset stick, and telling an operator to go and find an
	 * ssh client that still speaks to a 2007 dropbear is how the default
	 * stays in place forever.
	 *
	 * The current credential is what authorises it -- serve() has already
	 * checked it, and a cross-origin POST is already refused -- so there is
	 * no second password prompt here. That is the same standard as every
	 * other write on this daemon, including the ones that change what the
	 * OLT authenticates against.
	 */
	/*
	 * SSH public keys for the device login.
	 *
	 * dropbear reads authorized_keys from the directory its -D names, and
	 * the image starts it with -D /etc/config/dropbear.d, beside the host
	 * key: the jffs2 partition, so a key survives a reflash the way the
	 * host key does. One line per key, OpenSSH format, as ssh-keygen prints
	 * it. GET lists them; POST with key=<line> appends one, POST with
	 * delete=<index> removes one, and with line=<text> beside it only while
	 * that line still reads so. The check on a new key is shape only --
	 * type word, base64 blob, optional comment, one line -- because the
	 * one failure that matters is a pasted line that is not a key at all,
	 * and dropbear itself decides whether the blob decodes.
	 */
	if (seq(path, "/api/sshkeys")) {
		static char keys[4096];
		long n = read_file(SSHKEYS_PATH, keys, sizeof(keys));
		unsigned long i, ls, idx;

		/* No file is no keys (-2 is ENOENT). A file that cannot be read,
		 * or that does not fit, is refused, the list included: read_file
		 * keeps what fits, so a delete wrote the file back without the
		 * rest, and after a read error an add replaced it with the one
		 * new key. One that fills the buffer to the last byte counts as
		 * cut; the two cannot be told apart. */
		if (n == -2)
			n = 0;
		if (n < 0 || (unsigned long)n + 1 >= sizeof(keys)) {
			respond(conn, "500 Internal Server Error", "application/json", 0);
			put_fd(conn, n < 0
			       ? "{\"ok\":false,\"error\":\"could not read authorized_keys\"}"
			       : "{\"ok\":false,\"error\":\"authorized_keys is larger than confd can hold (4 KB); edit it over ssh\"}");
			return;
		}
		keys[n] = 0;
		if (seq(method, "POST")) {
			char key[1024], del[8];

			if (form_get(body, "delete", del, sizeof(del)) && del[0]) {
				static char line[sizeof(keys)];
				unsigned long want = 0, at = 0, out = 0;
				int found = 0;
				/* The line the caller saw at that number. The page
				 * sends it; without it the number alone decides, as
				 * it always did. */
				int pinned = form_has(body, "line");

				if (pinned && !form_get(body, "line", line, sizeof(line))) {
					respond(conn, "400 Bad Request", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"line is too long or badly encoded\"}");
					return;
				}

				for (i = 0; del[i]; i++) {
					if (del[i] < '0' || del[i] > '9') {
						/* Not a number is not line 0. */
						respond(conn, "400 Bad Request", "application/json", 0);
						put_fd(conn, "{\"ok\":false,\"error\":\"delete must be a line number\"}");
						return;
					}
					want = want * 10 + (unsigned long)(del[i] - '0');
				}
				/* Rewrite in place without the wanted line. */
				for (ls = 0; ls < (unsigned long)n; ) {
					unsigned long le = ls;

					while (keys[le] && keys[le] != '\n')
						le++;
					if (keys[le] == '\n')
						le++;
					if (at == want) {
						unsigned long ll = le - ls, k = 0;

						if (ll && keys[le - 1] == '\n')
							ll--;
						while (pinned && k < ll && line[k] == keys[ls + k])
							k++;
						/* A list from before another tab or an ssh
						 * session changed the file: the number now
						 * names a different key. */
						if (pinned && (k < ll || line[k])) {
							respond(conn, "409 Conflict", "application/json", 0);
							put_fd(conn, "{\"ok\":false,\"error\":\"the key list has changed; nothing was removed\"}");
							return;
						}
						found = 1;
					} else {
						unsigned long k;

						for (k = ls; k < le; k++)
							keys[out++] = keys[k];
					}
					at++;
					ls = le;
				}
				if (!found) {
					respond(conn, "404 Not Found", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"no such key\"}");
					return;
				}
				if (write_file_atomic(SSHKEYS_PATH, keys, out, 0600) < 0) {
					respond(conn, "500 Internal Server Error", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"could not write authorized_keys\"}");
					return;
				}
				respond(conn, "200 OK", "application/json", 0);
				put_fd(conn, "{\"ok\":true}");
				return;
			}
			if (!form_get(body, "key", key, sizeof(key)) || !key[0] ||
			    str_len(key) > 1000) {
				respond(conn, "400 Bad Request", "application/json", 0);
				put_fd(conn, "{\"ok\":false,\"error\":\"a key is required: one line, up to 1000 characters\"}");
				return;
			}
			{
				const char *why = sshkey_refusal(key, keys);

				if (why) {
					respond(conn, "400 Bad Request", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"");
					put_json_cstr(conn, why);
					put_fd(conn, "\"}");
					return;
				}
			}
			/* One byte short of the buffer, or the file this writes
			 * would read back as one that does not fit. */
			if ((unsigned long)n + str_len(key) + 2 > sizeof(keys) - 2) {
				respond(conn, "400 Bad Request", "application/json", 0);
				put_fd(conn, "{\"ok\":false,\"error\":\"authorized_keys is full\"}");
				return;
			}
			if (n && keys[n - 1] != '\n')
				keys[n++] = '\n';
			for (i = 0; key[i]; i++)
				keys[n++] = key[i];
			keys[n++] = '\n';
			{
				static char *const mk[] = { "mkdir", "-p", SSHKEYS_DIR, 0 };
				char junk[64];

				run_to_buf("/bin/mkdir", mk, junk, sizeof(junk),
					  MKDIR_TIMEOUT_MS);
			}
			if (write_file_atomic(SSHKEYS_PATH, keys, (unsigned long)n, 0600) < 0) {
				respond(conn, "500 Internal Server Error", "application/json", 0);
				put_fd(conn, "{\"ok\":false,\"error\":\"could not write authorized_keys\"}");
				return;
			}
			respond(conn, "200 OK", "application/json", 0);
			put_fd(conn, "{\"ok\":true}");
			return;
		}
		/* GET: one object per line, blank and comment lines skipped but
		 * counted, so the index the page sends back to delete is the line
		 * number in the file. */
		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"path\":\"" SSHKEYS_PATH "\",\"keys\":[");
		idx = 0;
		{
			int first = 1;

			for (ls = 0; ls < (unsigned long)n; idx++) {
				unsigned long le = ls;
				char saved;

				while (keys[le] && keys[le] != '\n')
					le++;
				saved = keys[le];
				keys[le] = 0;
				if (keys[ls] && keys[ls] != '#') {
					if (!first)
						put_fd(conn, ",");
					first = 0;
					put_fd(conn, "{\"i\":");
					put_u32_fd(conn, idx);
					put_fd(conn, ",\"line\":\"");
					put_json_cstr(conn, keys + ls);
					put_fd(conn, "\"}");
				}
				keys[le] = saved;
				ls = saved ? le + 1 : le;
			}
		}
		put_fd(conn, "]}");
		return;
	}

	if (seq(path, "/api/password") && seq(method, "POST")) {
		/* Room for far more than the rules allow, so that a name or a
		 * password that is too long is told its limit by set_credential
		 * and not "required" because it did not fit a buffer. */
		char user[256], pass[512];
		const char *why = 0;

		if (!form_get(body, "user", user, sizeof(user)) ||
		    !form_get(body, "password", pass, sizeof(pass))) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"user and password are required, "
				     "and must be 64 and 128 characters at most\"}");
			return;
		}
		if (!set_credential(user, pass, &why)) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"");
			put_json_cstr(conn, why ? why : "refused");
			put_fd(conn, "\"}");
			return;
		}
		/* Whoever signed in with the old password is signed out; the
		 * browser that made the change stays signed in. */
		session_end_others();
		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"ok\":true,\"note\":\"saved -- every other browser signed in to this page is signed out\"}");
		return;
	}

	/*
	 * Reset the service configuration to the image defaults.
	 *
	 * NOT flash_eraseall /dev/mtd3, which is the recipe every thread gives
	 * and the reason Anime4000/RTL960x#84 has people with dead sticks. That
	 * erases the whole config partition: both stores, the identity in the
	 * hs store, this daemon's own credential file, and any override binary
	 * living beside it.
	 *
	 * `flash default cs` is per-store, and cs only. On the stock firmware it
	 * is the vendor's reset of the whole service store; on odi-oss it merges
	 * /etc/config_default.xml (ten keys: the LOIDs, DEVICE_TYPE,
	 * DUAL_MGMT_MODE, the OMCI_CUSTOM masks) and leaves every other key as
	 * it was, because the store is shared with the stock slot. Either way it
	 * rewrites /var/config/lastgood.xml rather than erasing the partition,
	 * so files there -- confd.auth, an overridden confd or metricsd -- and
	 * the values that cannot be regenerated survive it.
	 *
	 * hs is deliberately not reachable. The reset people want is the
	 * service one; the one that ends sticks is the other.
	 */
	if (seq(path, "/api/reset") && seq(method, "POST")) {
		static char *const argv[] = { "flash", "default", "cs", 0 };
		char confirm[16];
		long got, code = -1;

		if (!form_get(body, "_confirm", confirm, sizeof(confirm)) ||
		    !seq(confirm, "reset")) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"resend with _confirm=reset\"}");
			return;
		}

		got = run_to_buf_ex(FLASH_PATH, argv, status, sizeof(status), &code,
				   FLASH_TIMEOUT_MS);
		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"ok\":");
		put_fd(conn, (got >= 0 && code == 0) ? "true" : "false");
		/* The script's own words. It reports "Reset CS to default
		 * configuration success." and it can also report FATAL ERROR
		 * from its space check, and the caller should see which. */
		put_fd(conn, ",\"output\":\"");
		if (got > 0)
			put_json_cstr(conn, status);
		put_fd(conn, "\"}");
		return;
	}

	/*
	 * Ping, from the stick.
	 *
	 * Proving the line from the ONU rather than from behind your router is
	 * the one diagnostic the vendor UI has that this did not, and it
	 * answers a question nothing else here can: whether the stick itself
	 * reaches anything.
	 *
	 * IPv4 literals only, and that is not laziness. This server is
	 * single-threaded and serial, so whatever ping does, every other
	 * request waits for it -- and a hostname means a DNS lookup on a device
	 * that, in bridge mode, has no route to a resolver. That lookup does
	 * not fail fast, it hangs, and it would take the whole UI with it. A
	 * literal cannot.
	 *
	 * Even so this blocks for a few seconds: three packets at one per
	 * second, and nothing else is served meanwhile.
	 */
	if (seq(path, "/api/ping") && seq(method, "POST")) {
		char host[64];
		char *argv[6];
		long got, code = -1;

		if (!form_get(body, "host", host, sizeof(host))) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"host is required\"}");
			return;
		}
		/* Four numbers 0-255 without leading zeros (busybox ping reads 010
		 * as octal), first one 1-223 and not 127: an address that can be
		 * pinged, not 0.0.0.0, loopback, multicast or broadcast. */
		if (!type_ok("ipv4host", host)) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"an IPv4 address like 192.168.1.254, "
				     "and only an address (no name, no leading zeros)\"}");
			return;
		}

		argv[0] = "ping";
		argv[1] = "-c";
		argv[2] = "3";
		argv[3] = host;
		argv[4] = 0;

		got = run_to_buf_ex(PING_PATH, argv, status, sizeof(status), &code,
				   PING_TIMEOUT_MS);
		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"ok\":");
		put_fd(conn, (got >= 0 && code == 0) ? "true" : "false");
		put_fd(conn, ",\"output\":\"");
		if (got > 0)
			put_json_cstr(conn, status);
		put_fd(conn, "\"");
		/*
		 * 127 is run_to_buf_ex's own "execve failed", not ping's. Worth
		 * separating: without this a missing /bin/ping reads as "no
		 * reply", which sends you to look at the network instead of at
		 * the image.
		 */
		if (code == 127)
			put_fd(conn, ",\"error\":\"no ping in this image\"");
		else if (got < 0)
			put_fd(conn, ",\"error\":\"could not run ping\"");
		put_fd(conn, "}");
		return;
	}

	if (seq(path, "/api/config") && seq(method, "POST")) {
		handle_write(conn, body);
		return;
	}

	if (seq(path, "/api/firmware")) {
		if (seq(method, "GET")) {
			emit_firmware_json(conn);
			return;
		}
		if (seq(method, "POST")) {
			char action[32], part[8];

			form_get(body, "action", action, sizeof(action));
			form_get(body, "partition", part, sizeof(part));

			/* Only ever 0 or 1. sw_tryactive == 2 is U-Boot's "no
			 * trial pending" state, and writing it here would mean
			 * silently doing nothing while reporting success.
			 *
			 * `write` belongs in this list and was missing from it,
			 * so a partition of 9 went through to fwu_starter.sh --
			 * which rejects it, but an argument this daemon has not
			 * checked is one it is trusting the next program to. */
			if ((seq(action, "try") || seq(action, "commit") ||
			     seq(action, "write") || seq(action, "cancel")) &&
			    !(seq(part, "0") || seq(part, "1"))) {
				respond(conn, "400 Bad Request", "application/json", 0);
				put_fd(conn, "{\"error\":\"partition must be 0 or 1\"}");
				return;
			}

			if (seq(action, "try")) {
				/* A write that has not reached the erase yet
				 * (sizes and md5s come first) still leaves the
				 * old kernel in place, and that is what a trial
				 * armed now would boot. */
				if (fwu_running()) {
					respond(conn, "409 Conflict", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"a firmware write is running; "
						     "try the partition once it has finished\"}");
					return;
				}
				respond(conn, "200 OK", "application/json", 0);
				/*
				 * Arm a slot only if its kernel is one U-Boot
				 * would boot. A slot that was never written, or
				 * whose flash was cut short, fails the header or
				 * data CRC at the bootloader, which then stops
				 * at its prompt until the watchdog or a power
				 * cycle takes the stick back: nothing to learn
				 * from that, and no reason to offer it.
				 */
				if (!slot_kernel_ok(part[0])) {
					put_fd(conn, "{\"ok\":false,\"error\":\"partition ");
					put_json_cstr(conn, part);
					put_fd(conn, " does not hold a kernel the bootloader would boot (bad or missing header, or the data CRC fails); write an image to it first\"}");
					return;
				}
				put_fd(conn, nv_set("sw_tryactive", part)
					? "{\"ok\":true,\"note\":\"armed\"}"
					: "{\"ok\":false,\"error\":\"nv setenv failed\"}");
				return;
			}
			/*
			 * Cancel a trial armed with try and not yet booted:
			 * sw_tryactive back to 2, U-Boot's "no trial pending".
			 * Without it an armed trial ran at the next reset of
			 * any kind, a power cut or the watchdog included, and
			 * the page could only say it was pending.
			 */
			if (seq(action, "cancel")) {
				char pend[8];

				if (!nv_get("sw_tryactive", pend, sizeof(pend)) || !seq(pend, part)) {
					respond(conn, "409 Conflict", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"no trial of partition ");
					put_json_cstr(conn, part);
					put_fd(conn, " is pending; nothing was changed\"}");
					return;
				}
				respond(conn, "200 OK", "application/json", 0);
				put_fd(conn, nv_set("sw_tryactive", "2")
					? "{\"ok\":true,\"note\":\"cancelled\"}"
					: "{\"ok\":false,\"error\":\"nv setenv failed\"}");
				return;
			}
			if (seq(action, "commit")) {
				char why[256], act[8];
				int rc;

				/*
				 * Only the running partition is ever committed, on every path below,
				 * the setenv fallback included: a slot that never booted must not
				 * become the permanent boot target, and a stale tab can name any
				 * slot. The running one is read here, never taken from the caller.
				 * When it cannot be read the commit is refused.
				 */
				if (!nv_get("sw_active", act, sizeof(act)) || !act[0]) {
					respond(conn, "400 Bad Request", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"cannot tell which partition this stick is running, so nothing was committed\"}");
					return;
				}
				if (!seq(act, part)) {
					respond(conn, "400 Bad Request", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"only the running partition can be committed, and partition ");
					put_json_cstr(conn, part);
					put_fd(conn, " is not the one this stick is running; nothing was committed\"}");
					return;
				}
				respond(conn, "200 OK", "application/json", 0);
				/*
				 * `nv commit` writes BOTH environment copies,
				 * read back, and refuses a slot that is not the
				 * running one. A plain setenv wrote one copy and
				 * left the other naming the old slot. The stock
				 * nv has no such verb (it prints its usage text): only then
				 * is the single setenv all there is, and the running-partition
				 * check above has already passed.
				 */
				rc = nv_commit(part, why, sizeof(why));
				if (rc < 0) {
					put_fd(conn, nv_set("sw_commit", part)
						? "{\"ok\":true,\"note\":\"committed in one environment copy: this nv cannot do both\"}"
						: "{\"ok\":false,\"error\":\"nv setenv failed\"}");
					return;
				}
				if (!rc) {
					put_fd(conn, "{\"ok\":false,\"error\":\"");
					put_json_cstr(conn, why[0] ? why : "nv commit failed");
					put_fd(conn, "\"}");
					return;
				}
				/*
				 * /var/run/odi-slot is written once at boot and
				 * read by the exporter and the trial banner:
				 * without this they keep saying "not committed"
				 * until the next reboot. The commit is already
				 * done, so a refresh that fails is reported, not
				 * turned into a failure.
				 */
				put_fd(conn, slot_state_refresh()
					? "{\"ok\":true,\"note\":\"committed\",\"refreshed\":true}"
					: "{\"ok\":true,\"note\":\"committed\",\"refreshed\":false}");
				return;
			}
			/*
			 * Write the uploaded image to a partition.
			 *
			 * fwu_starter.sh extracts fwu.sh and md5.txt from the
			 * tar, checks fwu.sh against its own md5, and only then
			 * runs it -- and fwu.sh verifies the kernel and rootfs
			 * md5s BEFORE erasing anything. So the integrity check
			 * that matters is already in the image; this route does
			 * not reimplement it.
			 *
			 * It blocks for about eighty seconds, and this server
			 * is serial, so nothing else is answered meanwhile.
			 * That is the honest behaviour for an operation you
			 * must not interrupt: a page that looked responsive
			 * during a flash would be inviting a second click.
			 */
			if (seq(action, "write")) {
				char *argv[4];
				long code = -1;

				argv[0] = "fwu_starter.sh";
				argv[1] = part;
				argv[2] = UPLOAD_PATH;
				argv[3] = 0;

				/* A running job reopens its archive after the
				 * erase, so a second write must not get as far
				 * as hashing or replacing anything. The starter
				 * would refuse too, but only after that. */
				if (fwu_running()) {
					respond(conn, "409 Conflict", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"a firmware write is running; "
						     "wait for it to finish\"}");
					return;
				}

				/* Refuse to write the partition that is
				 * running. fwu.sh would too, but finding that
				 * out after the erase has started is not the
				 * place to learn it. */
				{
					char act[8];

					/* Unknown is not "the other one", as for
					 * commit: without a confirmed sw_active this
					 * route does not decide what may be erased. */
					if (!nv_get("sw_active", act, sizeof(act)) ||
					    !(seq(act, "0") || seq(act, "1"))) {
						respond(conn, "409 Conflict", "application/json", 0);
						put_fd(conn, "{\"ok\":false,\"error\":\"cannot tell which partition this stick is running (sw_active unreadable); nothing was written\"}");
						return;
					}
					if (seq(act, part)) {
						respond(conn, "400 Bad Request", "application/json", 0);
						put_fd(conn, "{\"ok\":false,\"error\":\"that is the partition this stick is running\"}");
						return;
					}
				}

				/* And the committed one while a trial runs: it
				 * is the image a failed trial goes back to.
				 * fwu_starter.sh only refuses an unreadable
				 * value; the refusal of this slot is in the
				 * fwu.sh inside the upload, which an older or a
				 * vendor tarball does not carry. */
				{
					char com[8];

					if (!nv_get("sw_commit", com, sizeof(com)) ||
					    !(seq(com, "0") || seq(com, "1"))) {
						respond(conn, "409 Conflict", "application/json", 0);
						put_fd(conn, "{\"ok\":false,\"error\":\"cannot tell which partition is committed (sw_commit unreadable); nothing was written\"}");
						return;
					}
					if (seq(com, part)) {
						respond(conn, "409 Conflict", "application/json", 0);
						put_fd(conn, "{\"ok\":false,\"error\":\"that is the committed partition, the image a failed trial goes back to; commit the running image first\"}");
						return;
					}
					/* And the slot the other environment copy
					 * still commits to: U-Boot boots that one if
					 * the winning copy is ever left invalid, and
					 * the trial banner says so. A stock nv has no
					 * fallback verb and answers nothing here; an
					 * nv that did not answer in time, or could
					 * not read that copy in full, is no knowing. */
					{
						/* A sw_commit there that names no
						 * slot is no knowing either. */
						int fb = nv_fallback_get("sw_commit", com, sizeof(com));

						if (fb < 0 || (fb > 0 && !seq(com, "0") && !seq(com, "1"))) {
							respond(conn, "409 Conflict", "application/json", 0);
							put_fd(conn, "{\"ok\":false,\"error\":\"the fallback copy of the U-Boot environment could not be read; nothing was written\"}");
							return;
						}
						if (fb > 0 && seq(com, part)) {
							respond(conn, "409 Conflict", "application/json", 0);
							put_fd(conn, "{\"ok\":false,\"error\":\"the fallback copy of the U-Boot environment still commits to that partition; commit the running image first\"}");
							return;
						}
					}
				}

				/* The image this write means, by the md5 its
				 * upload answered. Only this daemon creates
				 * UPLOAD_PATH, so a second tab's upload is the
				 * one way the file changes under the page, and
				 * the md5s inside the tar cannot tell: they only
				 * prove it is whole. The file is hashed again
				 * here, right before the starter gets it. */
				{
					static char *const margv[] = { "md5sum", UPLOAD_PATH, 0 };
					char want[40], now[128];
					long n;

					form_get(body, "md5", want, sizeof(want));
					if (!upload_md5[0] || !seq(want, upload_md5)) {
						respond(conn, "409 Conflict", "application/json", 0);
						put_fd(conn, upload_md5[0]
							? "{\"ok\":false,\"error\":\"the uploaded image has changed since this page uploaded it; upload it again\"}"
							: "{\"ok\":false,\"error\":\"no upload this daemon received is waiting to be written; upload the image again\"}");
						return;
					}
					n = run_to_buf(MD5SUM_PATH, margv, now, sizeof(now), MD5SUM_TIMEOUT_MS);
					if (n < 32 || (now[32] != ' ' && now[32] != '\n')) {
						respond(conn, "409 Conflict", "application/json", 0);
						put_fd(conn, "{\"ok\":false,\"error\":\"the uploaded image could not be hashed again; upload it again\"}");
						return;
					}
					now[32] = 0;
					if (!seq(now, upload_md5)) {
						upload_md5[0] = 0;
						syscall3(__NR_unlink, (long)UPLOAD_PATH, 0, 0);
						respond(conn, "409 Conflict", "application/json", 0);
						put_fd(conn, "{\"ok\":false,\"error\":\"the file on the stick is no longer the image this page uploaded; upload it again\"}");
						return;
					}
				}

				/* A trial armed on this partition would boot the
				 * write at its first reset, half written if the
				 * write is cut short. A value that cannot be read,
				 * or is none of 0, 1 and 2, is not "no trial". */
				{
					char pend[8];

					if (!nv_get("sw_tryactive", pend, sizeof(pend)) ||
					    !(seq(pend, "0") || seq(pend, "1") || seq(pend, "2"))) {
						respond(conn, "409 Conflict", "application/json", 0);
						put_fd(conn, "{\"ok\":false,\"error\":\"cannot tell whether a trial is pending (sw_tryactive unreadable); nothing was written\"}");
						return;
					}
					if (seq(pend, part)) {
						respond(conn, "409 Conflict", "application/json", 0);
						put_fd(conn, "{\"ok\":false,\"error\":\"a trial of this partition is pending; cancel it before writing\"}");
						return;
					}
				}

				if (run_to_buf_ex(FWU_STARTER, argv, status,
						  sizeof(status), &code,
						  FWU_TIMEOUT_MS) < 0) {
					respond(conn, "500 Internal Server Error", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"could not run the updater\"}");
					return;
				}
				respond(conn, "200 OK", "application/json", 0);
				put_fd(conn, "{\"ok\":");
				put_fd(conn, code == 0 ? "true" : "false");
				put_fd(conn, ",\"output\":\"");
				put_json_cstr(conn, status);
				put_fd(conn, "\"}");
				return;
			}

			if (seq(action, "reboot")) {
				static char *const rb[] = { "sh", 0 };
				static const char script[] =
					"trap '' HUP\n"
					"( sleep 1; /sbin/reboot || /bin/reboot ) >/dev/null 2>&1 &\n";
				char out[64];

				/*
				 * A reboot in the middle of a write leaves the
				 * partition half erased, and the upload refuses
				 * for the same reason. The write is what the
				 * page is following; say so, and do not reboot.
				 */
				if (fwu_running()) {
					respond(conn, "409 Conflict", "application/json", 0);
					put_fd(conn, "{\"ok\":false,\"error\":\"a firmware write is running; "
						     "rebooting now would leave the partition half written. "
						     "Wait for it to finish\"}");
					return;
				}

				/* Answer first, then reboot a second later: the
				 * reply cannot be delivered by a kernel that is
				 * already going down. */
				respond(conn, "200 OK", "application/json", 0);
				put_fd(conn, "{\"ok\":true,\"note\":\"rebooting\"}");
				run_script_to_buf("/bin/sh", rb, script, out, sizeof(out),
						 REBOOT_TIMEOUT_MS);
				return;
			}
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"error\":\"unknown action\"}");
			return;
		}
	}

	/*
	 * Apply saved settings, when the caller asks. `what` names the action
	 * the write response listed: network or sfp (live), or omci (interrupts the
	 * internet). The page asks for confirmation before omci; this route
	 * does not second-guess it, but it never runs one the caller did not
	 * name, and a save never triggers one by itself.
	 *
	 * The image's apply.sh does the work and says what it did. Without
	 * one, omci falls back to restarting the stock omci_app, the only apply
	 * a stock-based image has, and network is refused.
	 *
	 * omci-live, what the page sends after a save of VLAN keys alone, runs
	 * apply.sh omci-live: omcid applies nothing that re-registers the ONU,
	 * and with an identity change waiting in the store it applies nothing
	 * at all, which apply.sh says with exit 3 (deferred). After a reload
	 * that left the ONU off the line (a failed activation, no_serial), the
	 * next one re-registers it, VLAN keys alone too, and apply.sh says so
	 * with exit 4: applied, with a re-registration. An apply.sh
	 * without that verb stops at its usage line before it does anything,
	 * and the answer says unsupported; so does an image without apply.sh,
	 * whose only apply restarts omci_app. Either way the change stays
	 * saved, and the page offers the full apply. It is an action of its
	 * own and not a flag on omci, so that a confd older than the page
	 * refuses it (400) instead of running the full apply: an update puts
	 * the web files in place before the confd that reads them.
	 */
	if (seq(path, "/api/apply") && seq(method, "POST")) {
		char what[16];   /* "network", "omci", "omci-live", "syslog", "ntp", "igmp" or "sfp" */
		long code = -1, got;
		int want_live;

		/* No what is omci, as it always was; a what that does not
		 * decode, or a body whose field names do not, is not "no what". */
		if (!form_valid(body)) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"the form could not be read\"}");
			return;
		}
		if (!form_has(body, "what"))
			str_copy(what, "omci", sizeof(what));
		else if (!form_get(body, "what", what, sizeof(what)))
			str_copy(what, "?", sizeof(what));
		else if (!what[0])
			str_copy(what, "omci", sizeof(what));
		if (!seq(what, "omci") && !seq(what, "omci-live") && !seq(what, "network") &&
		    !seq(what, "syslog") && !seq(what, "ntp") && !seq(what, "igmp") &&
		    !seq(what, "sfp")) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"what must be network, omci, omci-live, syslog, ntp, igmp or sfp\"}");
			return;
		}
		want_live = seq(what, "omci-live");
		if (file_exists(APPLY_PATH)) {
			char *argv[3];
			int ok, rereg, unsupported;

			argv[0] = "apply.sh";
			argv[1] = what;
			argv[2] = 0;
			got = run_to_buf_ex(APPLY_PATH, argv, status, sizeof(status), &code,
					   APPLY_TIMEOUT_MS);
			rereg = want_live && got >= 0 && code == 4;
			ok = got >= 0 && (code == 0 || rereg);
			unsupported = want_live && got > 0 && code == 1 && spre(status, "usage:");
			respond(conn, "200 OK", "application/json", 0);
			put_fd(conn, "{\"ok\":");
			put_fd(conn, ok ? "true" : "false");
			put_fd(conn, ",\"applied\":");
			put_fd(conn, ok ? "true" : "false");
			if (want_live && got >= 0 && code == 3)
				put_fd(conn, ",\"deferred\":true");
			if (rereg)
				put_fd(conn, ",\"reregistered\":true");
			if (unsupported)
				put_fd(conn, ",\"unsupported\":true");
			put_fd(conn, ",\"output\":\"");
			if (got > 0)
				put_json_cstr(conn, status);
			put_fd(conn, "\"}");
			return;
		}
		respond(conn, "200 OK", "application/json", 0);
		if (want_live) {
			put_fd(conn, "{\"ok\":false,\"applied\":false,\"unsupported\":true,"
				     "\"error\":\"this image has no " APPLY_PATH "; only the full apply restarts omci_app\"}");
			return;
		}
		if (!seq(what, "omci")) {
			put_fd(conn, "{\"ok\":false,\"applied\":false,"
				     "\"error\":\"this image has no " APPLY_PATH "; reboot to apply\"}");
			return;
		}
		put_fd(conn, apply_omci() ? "{\"ok\":true,\"applied\":true}"
					  : "{\"ok\":false,\"applied\":false,\"error\":\"omci_app did not come back\"}");
		return;
	}

	/*
	 * The host-port auto-negotiation. GET reads the state the image keeps
	 * (confd.h, HOSTLINK_*, SAFEMODE_FLAG, RESEED_RECORD): no fork, so the
	 * page can poll it through a trial. POST runs host-autoneg.sh with try,
	 * confirm or revert, safe-mode.sh with ack, or config-reseed.sh with
	 * ack (reseed-ack); the scripts own the trial, the revert timer, the
	 * stored key and the two records, and the page only relays what they
	 * said. try answers before the link changes
	 * (the script applies the mode a second later), so this answer always
	 * leaves.
	 *
	 * The SerDes mode rides on the same route: GET adds the state file of
	 * host-serdes.sh, and POST has the verbs serdes-try (mode fiber1g,
	 * 2500basex or hisgmii), serdes-confirm, serdes-revert and
	 * serdes-status, which also answers the script's key=value lines as
	 * `status`.
	 */
	if (seq(path, "/api/hostlink")) {
		if (seq(method, "GET")) {
			respond(conn, "200 OK", "application/json", 0);
			emit_hostlink_body(conn);
			return;
		}
		if (seq(method, "POST")) {
			char action[16], mode[12];
			char *argv[4];
			const char *script = HOSTLINK_SCRIPT;
			int is_status = 0;
			long code = -1, got;

			if (!form_get(body, "action", action, sizeof(action)))
				action[0] = 0;
			if (!form_get(body, "mode", mode, sizeof(mode)))
				mode[0] = 0;
			argv[0] = "host-autoneg.sh";
			argv[2] = 0;
			argv[3] = 0;
			if (seq(action, "try") && (seq(mode, "on") || seq(mode, "off"))) {
				argv[1] = "try";
				argv[2] = mode;
			} else if (seq(action, "serdes-try") &&
				   (seq(mode, "fiber1g") || seq(mode, "2500basex") ||
				    seq(mode, "hisgmii"))) {
				script = SERDES_SCRIPT;
				argv[0] = "host-serdes.sh";
				argv[1] = "try";
				argv[2] = mode;
			} else if (seq(action, "serdes-confirm") || seq(action, "serdes-revert") ||
				   seq(action, "serdes-status")) {
				/* Fixed verbs: the text after the dash is a literal. */
				script = SERDES_SCRIPT;
				argv[0] = "host-serdes.sh";
				argv[1] = seq(action, "serdes-confirm") ? "confirm" :
					  seq(action, "serdes-revert") ? "revert" : "status";
				is_status = seq(action, "serdes-status");
			} else if (seq(action, "confirm") || seq(action, "revert")) {
				argv[1] = action;
			} else if (seq(action, "ack")) {
				/* The safe-mode record belongs to safe-mode.sh; its ack
				 * also holds a safe-mode boot that would end by itself. */
				script = SAFEMODE_SCRIPT;
				argv[0] = "safe-mode.sh";
				argv[1] = action;
			} else if (seq(action, "reseed-ack")) {
				/* The record of a recreated config store belongs to config-reseed.sh. */
				script = RESEED_SCRIPT;
				argv[0] = "config-reseed.sh";
				argv[1] = "ack";
			} else {
				respond(conn, "400 Bad Request", "application/json", 0);
				put_fd(conn, "{\"ok\":false,\"error\":\"action must be try (mode on or off), confirm, revert, ack, reseed-ack, serdes-try (mode fiber1g, 2500basex or hisgmii), serdes-confirm, serdes-revert or serdes-status\"}");
				return;
			}
			if (!file_exists(script)) {
				respond(conn, "200 OK", "application/json", 0);
				put_fd(conn, "{\"ok\":false,\"error\":\"this image has no ");
				put_json_cstr(conn, script);
				put_fd(conn, "\"}");
				return;
			}
			got = run_to_buf_ex(script, argv, status, sizeof(status), &code,
					   HOSTLINK_TIMEOUT_MS);
			respond(conn, "200 OK", "application/json", 0);
			put_fd(conn, "{\"ok\":");
			put_fd(conn, (got >= 0 && code == 0) ? "true" : "false");
			put_fd(conn, ",\"output\":\"");
			if (got > 0)
				put_json_cstr(conn, status);
			put_fd(conn, "\"");
			if (is_status) {
				/* The lines of `status`, as the page reads the state. */
				put_fd(conn, ",\"status\":{");
				if (got > 0)
					put_kv_members(conn, status);
				put_fd(conn, "}");
			}
			put_fd(conn, got == -2 ? ",\"error\":\"the script did not answer in time\"}" : "}");
			return;
		}
	}

	/*
	 * The management addresses, as a trial (confd.h, NETADDR_*). GET reads
	 * the state the image keeps, with no fork, and says which address this
	 * request came in on (`via`) and who sent it (`peer`), so the page can
	 * tell whether a Keep from here would be accepted. POST runs
	 * mgmt-addr.sh: try with the keys the page changed, confirm with the
	 * address and the client of THIS connection (taken from the socket, never
	 * from the request), or revert. The script owns the trial, its timer and
	 * the store; the page only relays what it said. try answers before the
	 * address moves (the script applies it a second later).
	 */
	if (seq(path, "/api/netaddr")) {
		if (seq(method, "GET")) {
			char buf[1024], via[16], peer[16];
			long got;

			conn_addr(conn, 0, via);
			conn_addr(conn, 1, peer);
			respond(conn, "200 OK", "application/json", 0);
			put_fd(conn, "{\"supported\":");
			put_fd(conn, netaddr_trial() ? "true" : "false");
			put_fd(conn, ",\"state\":{");
			got = read_file(NETADDR_STATE, buf, sizeof(buf));
			if (got > 0)
				put_kv_members(conn, buf);
			put_fd(conn, "},\"via\":\"");
			put_json_cstr(conn, via);
			put_fd(conn, "\",\"peer\":\"");
			put_json_cstr(conn, peer);
			put_fd(conn, "\",\"uptime\":\"");
			got = read_file(UPTIME_FILE, buf, sizeof(buf));
			if (got > 0) {
				unsigned long k = 0;

				while (buf[k] >= '0' && buf[k] <= '9')
					k++;
				put_json_str(conn, buf, k);
			}
			put_fd(conn, "\"}");
			return;
		}
		if (seq(method, "POST")) {
			char action[16], via[16], peer[16];
			char kv[5][48], rkv[VALUE_MAX + 16];
			char *argv[10];
			const char *err = 0;
			unsigned long argc = 0, nk = 0;
			long code = -1, got;
			int i;

			if (!form_get(body, "action", action, sizeof(action)))
				action[0] = 0;
			argv[argc++] = "mgmt-addr.sh";
			if (seq(action, "try")) {
				argv[argc++] = "try";
				for (i = 0; netaddr_keys[i]; i++) {
					char val[32];
					unsigned long j, k = 0;

					if (seq(netaddr_keys[i], "LAN_ROUTES")) {
						/* The routes: digits, dots, slashes, commas,
						 * spaces and the words default and via, and
						 * nothing else. Empty is allowed, it is how
						 * the routes are turned off. The grammar and
						 * the gateways are judged as /api/config
						 * judges them. One argv word, no shell. */
						char rv[VALUE_MAX + 1];

						if (!form_get(body, "LAN_ROUTES", rv, sizeof(rv)))
							continue;
						for (j = 0; rv[j]; j++) {
							char c = rv[j];

							if (!((c >= '0' && c <= '9') || c == '.' || c == '/' ||
							      c == ',' || c == ' ' || c == 'd' || c == 'e' ||
							      c == 'f' || c == 'a' || c == 'u' || c == 'l' ||
							      c == 't' || c == 'v' || c == 'i'))
								err = "routes use digits, dots, slashes, commas, "
								      "spaces and the words default and via";
						}
						if (!err && !type_ok("routes", rv))
							err = "not valid for its type";
						if (!err)
							err = key_refusal("LAN_ROUTES", rv, body);
						if (err)
							break;
						for (j = 0; "LAN_ROUTES="[j]; j++)
							rkv[k++] = "LAN_ROUTES="[j];
						for (j = 0; rv[j]; j++)
							rkv[k++] = rv[j];
						rkv[k] = 0;
						argv[argc++] = rkv;
						nk++;
						continue;
					}
					if (!form_get(body, netaddr_keys[i], val, sizeof(val)))
						continue;
					/* Digits and dots, or the 0/1 of the switch: nothing
					 * the script could read as anything but a value. The
					 * script and network.sh judge the rest. */
					if (!val[0])
						err = "a value cannot be empty";
					for (j = 0; val[j]; j++)
						if (!((val[j] >= '0' && val[j] <= '9') || val[j] == '.'))
							err = "a value is digits and dots";
					if (!err && seq(netaddr_keys[i], "LAN_ENABLE_IP2") &&
					    !seq(val, "0") && !seq(val, "1"))
						err = "LAN_ENABLE_IP2 is 0 or 1";
					if (!err && !seq(netaddr_keys[i], "LAN_ENABLE_IP2") &&
					    !type_ok(seq(netaddr_keys[i], "LAN_SUBNET") ||
						     seq(netaddr_keys[i], "LAN_SUBNET2") ? "netmask" : "ipv4host", val))
						err = "not valid for its type";
					if (!err)
						err = lan_pair_refusal(netaddr_keys[i], val, body);
					if (!err)
						err = key_refusal(netaddr_keys[i], val, body);
					if (err)
						break;
					/* KEY=VALUE, one argv word. */
					for (j = 0; netaddr_keys[i][j]; j++)
						kv[nk][k++] = netaddr_keys[i][j];
					kv[nk][k++] = '=';
					for (j = 0; val[j]; j++)
						kv[nk][k++] = val[j];
					kv[nk][k] = 0;
					argv[argc++] = kv[nk++];
				}
				if (!err && !nk)
					err = "no management address key to try";
			} else if (seq(action, "confirm")) {
				/* The proof that the new address works is the address
				 * this request arrived on, so it is the socket that says. */
				conn_addr(conn, 0, via);
				conn_addr(conn, 1, peer);
				argv[argc++] = "confirm";
				argv[argc++] = via;
				argv[argc++] = peer;
			} else if (seq(action, "revert")) {
				argv[argc++] = "revert";
			} else {
				err = "action must be try (with the keys), confirm or revert";
			}
			if (err) {
				respond(conn, "400 Bad Request", "application/json", 0);
				put_fd(conn, "{\"ok\":false,\"error\":\"");
				put_json_cstr(conn, err);
				put_fd(conn, "\"}");
				return;
			}
			argv[argc] = 0;
			if (!file_exists(NETADDR_SCRIPT)) {
				respond(conn, "200 OK", "application/json", 0);
				put_fd(conn, "{\"ok\":false,\"error\":\"this image has no " NETADDR_SCRIPT "\"}");
				return;
			}
			got = run_to_buf_ex(NETADDR_SCRIPT, argv, status, sizeof(status), &code,
					   NETADDR_TIMEOUT_MS);
			respond(conn, "200 OK", "application/json", 0);
			put_fd(conn, "{\"ok\":");
			put_fd(conn, (got >= 0 && code == 0) ? "true" : "false");
			put_fd(conn, ",\"output\":\"");
			if (got > 0)
				put_json_cstr(conn, status);
			put_fd(conn, got == -2 ? "\",\"error\":\"the script did not answer in time\"}" : "\"}");
			return;
		}
	}

	/*
	 * Create or remove one switch file on the config partition, from the
	 * allowlist in confd.h. Only the name is compared; the path is built
	 * from the literal, never from the request.
	 */
	if (seq(path, "/api/switch") && seq(method, "POST")) {
		char name[48], on[4];
		static const char p_identity[] = SWITCH_DIR SWITCH_OMCI_IDENTITY;
		static const char p_setup[] = SWITCH_DIR SWITCH_CONFD_SETUP;
		static const char p_update[] = SWITCH_DIR SWITCH_UPDATE_OFF;
		const char *target = 0;

		form_get(body, "name", name, sizeof(name));
		if (!form_get(body, "on", on, sizeof(on)) ||
		    !(seq(on, "0") || seq(on, "1"))) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"on must be 0 or 1\"}");
			return;
		}
		if (seq(name, SWITCH_OMCI_IDENTITY))
			target = p_identity;
		else if (seq(name, SWITCH_CONFD_SETUP))
			target = p_setup;
		else if (seq(name, SWITCH_UPDATE_OFF))
			target = p_update;
		if (!target) {
			respond(conn, "400 Bad Request", "application/json", 0);
			put_fd(conn, "{\"ok\":false,\"error\":\"not a switch this UI sets\"}");
			return;
		}
		if (seq(on, "1"))
			write_file(target, "", 0, 0644);
		else
			syscall3(__NR_unlink, (long)target, 0, 0);
		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"ok\":");
		put_fd(conn, file_exists(target) == seq(on, "1") ? "true" : "false");
		put_fd(conn, ",\"on\":");
		put_fd(conn, file_exists(target) ? "true" : "false");
		put_fd(conn, "}");
		return;
	}

	/* The clear view of the phone lines; the password is checked inside. */
	if (seq(path, "/api/voip/secrets") && seq(method, "POST")) {
		emit_voip_secrets_json(conn, body);
		return;
	}

	/* The router's report of its SIP registration state, for the line status. */
	if (seq(path, "/api/voip/status") && seq(method, "POST")) {
		emit_voip_status_post(conn, body);
		return;
	}

	if (!seq(method, "GET")) {
		respond(conn, "405 Method Not Allowed", "text/plain",
			"Allow: GET, POST\r\n");
		return;
	}

	/* The image files, one route each, and all of them in /api/static. */
	{
		const struct tsv_route *t = tsv_route_for(path);

		if (t) {
			if (tsv_load(t) < 0) {
				if (t->required) {
					respond(conn, "500 Internal Server Error", "application/json", 0);
					put_fd(conn, "{\"error\":\"no schema\"}");
					return;
				}
				respond(conn, "200 OK", "application/json", 0);
				put_fd(conn, "[]");
				return;
			}
			if (respond_cached(conn, "application/json", t->buf, slen(t->buf)))
				return;
			emit_tsv_json(conn, t->buf, t->col, t->ncol);
			return;
		}
	}

	if (seq(path, "/api/defaults")) {
		long n = load_defaults();

		if (respond_cached(conn, "application/json", values, (unsigned long)n))
			return;
		emit_values_json(conn, values);
		return;
	}

	/*
	 * Everything the page reads when it opens that changes only with the
	 * image, in one answer with one tag: the routes in tsv_routes plus the
	 * defaults. Usually a 304. Each file is read twice, once for the tag and
	 * once to emit it, because they share buffers; they are small and the
	 * reads cost little next to a request.
	 */
	if (seq(path, "/api/static")) {
		unsigned long h = etag_start(), i;
		long n;

		for (i = 0; i < TSV_ROUTES; i++) {
			const struct tsv_route *t = &tsv_routes[i];

			n = tsv_load(t);
			if (n < 0 && t->required) {
				respond(conn, "500 Internal Server Error", "application/json", 0);
				put_fd(conn, "{\"error\":\"no schema\"}");
				return;
			}
			h = etag_add(h, t->name, slen(t->name) + 1);
			if (n > 0)
				h = etag_add(h, t->buf, (unsigned long)n);
		}
		n = load_defaults();
		h = etag_add(h, "defaults", 9);
		h = etag_add(h, values, (unsigned long)n);
		if (respond_tagged(conn, "application/json", h))
			return;

		put_fd(conn, "{");
		for (i = 0; i < TSV_ROUTES; i++) {
			const struct tsv_route *t = &tsv_routes[i];

			put_fd(conn, i ? ",\"" : "\"");
			put_fd(conn, t->name);
			put_fd(conn, "\":");
			if (tsv_load(t) > 0)
				emit_tsv_json(conn, t->buf, t->col, t->ncol);
			else
				put_fd(conn, "[]");
		}
		put_fd(conn, ",\"defaults\":");
		load_defaults();
		emit_values_json(conn, values);
		put_fd(conn, "}");
		return;
	}

	/*
	 * What the page reads when it opens that the device holds: the config
	 * values, the firmware slots and the host link, each as its own route
	 * answers it. no-store, like those routes. A config store that cannot be
	 * read fails the whole answer, as /api/values does, since the page
	 * cannot show a form without it.
	 */
	if (seq(path, "/api/init")) {
		long n = load_values(0);

		if (n < 0) {
			respond(conn, "500 Internal Server Error", "application/json", 0);
			put_fd(conn, n == -2
			       ? "{\"error\":\"the config store is larger than confd can hold (64 KB)\"}"
			       : "{\"error\":\"flash failed\"}");
			return;
		}
		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"values\":");
		emit_values_json(conn, values);
		put_fd(conn, ",\"firmware\":");
		emit_firmware_body(conn);
		put_fd(conn, ",\"hostlink\":");
		emit_hostlink_body(conn);
		put_fd(conn, "}");
		return;
	}

	if (seq(path, "/api/values")) {
		long n = load_values(0);

		if (n == -2) {
			respond(conn, "500 Internal Server Error", "application/json", 0);
			put_fd(conn, "{\"error\":\"the config store is larger than confd can hold (64 KB)\"}");
			return;
		}
		if (n < 0) {
			respond(conn, "500 Internal Server Error", "application/json", 0);
			put_fd(conn, "{\"error\":\"flash failed\"}");
			return;
		}
		respond(conn, "200 OK", "application/json", 0);
		emit_values_json(conn, values);
		return;
	}

	/*
	 * The whole config store, as a file.
	 *
	 * This exists because of what it prevents. `flash_eraseall /dev/mtd3`
	 * is the standard factory-reset recipe for this device and it wipes the
	 * config partition -- which is also where ELAN_MAC_ADDR and MAC_KEY
	 * live. Without those the ONU never gets past O0, so the reset that was
	 * meant to fix a stick ends it. Anime4000/RTL960x#84 has people doing
	 * exactly that, including one who ran it across mtd3, mtd4 and mtd5 and
	 * lost the device entirely.
	 *
	 * So: a backup you can take in one click, BEFORE, containing the values
	 * you cannot regenerate. It is served as a download rather than shown,
	 * because a page you have to remember to copy out of is not a backup.
	 *
	 * It carries the identity keys in clear. That is the point of it, and
	 * it is why it needs the same credential as everything else.
	 */
	if (seq(path, "/api/backup")) {
		long n = load_values(1);

		/* A cut backup would be missing the hs store, the one part that
		 * cannot be regenerated, while looking complete. */
		if (n == -2) {
			respond(conn, "500 Internal Server Error", "text/plain", 0);
			put_fd(conn, "the config store is larger than confd can hold (64 KB); "
				     "copy /var/config off the stick instead\n");
			return;
		}
		/* Nor one where a dump failed or printed nothing: the file would
		 * hold flash's error line, or no hs store, under the same header. */
		if (n < 0) {
			respond(conn, "500 Internal Server Error", "text/plain", 0);
			put_fd(conn, "flash failed\n");
			return;
		}
		respond(conn, "200 OK", "text/plain; charset=utf-8",
			"Content-Disposition: attachment; filename=\"odi-config-backup.xml\"\r\n");
		put_fd(conn, "<!-- ODI DFP-34X-2C2 configuration backup.\n"
			     "     Both stores, exactly as `flash all cs` and `flash all hs` print them.\n"
			     "     Restore a key with:  flash set <NAME> <VALUE>\n"
			     "     The ones you cannot regenerate are GPON_SN, ELAN_MAC_ADDR and\n"
			     "     MAC_KEY: without them the ONU does not get past O0, and erasing\n"
			     "     /dev/mtd3 is what takes them away.\n"
			     "     confd build " BUILD_ID " -->\n");
		write_all(conn, values, slen(values));
		return;
	}

	/*
	 * The stick's own clock and what ntpd last said, for the Config tab:
	 * "now" is read here, so the page can compare it with the browser.
	 * No fork, one small file; "ntp" is null while the file is absent
	 * (NTP off, or ntpd just started).
	 */
	if (seq(path, "/api/ntp")) {
		respond(conn, "200 OK", "application/json", 0);
		put_fd(conn, "{\"now\":");
		put_u32_fd(conn, wall_s());
		put_fd(conn, ",\"ntp\":");
		if (!emit_ntp_status(conn))
			put_fd(conn, "null");
		put_fd(conn, "}");
		return;
	}

	if (seq(path, "/api/status")) {
		respond(conn, "200 OK", "application/json", 0);
		emit_status_json(conn);
		return;
	}

	/* The PON load figure alone, between status polls; see status.c. */
	if (seq(path, "/api/ponload")) {
		respond(conn, "200 OK", "application/json", 0);
		emit_ponload_json(conn);
		return;
	}

	/* The diagnostics bundle, redacted by the image script; see status.c. */
	if (seq(path, "/api/diag")) {
		emit_diag_bundle(conn);
		return;
	}

	if (seq(path, "/api/log")) {
		respond(conn, "200 OK", "application/json", 0);
		emit_log_json(conn);
		return;
	}

	if (seq(path, "/api/l2")) {
		respond(conn, "200 OK", "application/json", 0);
		emit_l2_json(conn);
		return;
	}

	/*
	 * The OMCI MIB: what the OLT provisioned, as opposed to what we asked
	 * for. Read-only, and allowlisted verb by verb inside -- see omci.c.
	 */
	if (seq(path, "/api/omci")) {
		emit_omci_json(conn, query);
		return;
	}

	/* What the OLT provisioned for the phone ports, masked; the secrets view
	 * needs the password again. See omci.c. */
	if (seq(path, "/api/voip/status") && seq(method, "GET")) {
		emit_voip_status_get(conn);
		return;
	}
	if (seq(path, "/api/voip") && seq(method, "GET")) {
		emit_voip_json(conn);
		return;
	}
	if (!serve_asset(conn, path)) {
		respond(conn, "404 Not Found", "text/plain", 0);
		put_fd(conn, "not found\n");
	}
}
