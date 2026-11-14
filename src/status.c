/*
 * The status scrape.
 */

#include "confd.h"
#include "buffers.h"
#include "http.h"
#include "status.h"

/*
 * The SoC temperature sensor, when the kernel has one.
 *
 * The odi-oss kernel registers an hwmon device named rtl9602c_soc: temp1_input
 * in millidegrees and, on newer images, the warning and critical limits and
 * their two alarm flags. Plain file reads, no fork. The device is found by
 * its name among hwmon0..7, because its number depends on what registered
 * first. A member is emitted only if its file exists and holds a plain
 * integer, so an older image shows less, never garbage; with no device, or no
 * temp1_input, nothing is emitted at all (a stock image). Values are parsed
 * and printed again, never echoed.
 */
const char *hwmon_root = HWMON_ROOT;

/* dir + file into path; the caller sizes it for both. */
static void join_path(char *path, unsigned long cap, const char *dir, const char *file)
{
	str_copy(path, dir, cap);
	str_copy(path + slen(path), file, cap - slen(path));
}

/* "[-]digits[\n]" as millidegrees: 0 and *out set, or -1 for anything else. */
static int read_milli(const char *dir, const char *file, long *out)
{
	char path[96], buf[16];
	unsigned long i = 0;
	long v = 0;
	int neg = 0;

	join_path(path, sizeof(path), dir, file);
	if (read_file(path, buf, sizeof(buf)) <= 0)
		return -1;
	if (buf[0] == '-')
		neg = i = 1;
	if (buf[i] < '0' || buf[i] > '9')
		return -1;
	for (; buf[i] >= '0' && buf[i] <= '9'; i++)
		v = v * 10 + (buf[i] - '0');
	if (buf[i] && buf[i] != '\n')
		return -1;
	*out = neg ? -v : v;
	return 0;
}

/* Millidegrees as degrees with one decimal, rounded half away from zero. */
static void put_celsius(int fd, long milli)
{
	unsigned long t = (unsigned long)(milli < 0 ? -milli : milli);

	t = (t + 50) / 100;
	if (milli < 0 && t)
		put_fd(fd, "-");
	put_u32_fd(fd, t / 10);
	put_fd(fd, ".");
	put_u32_fd(fd, t % 10);
}

static void emit_chip_temp(int fd)
{
	static const char *const limits[] = { "max", "crit" };
	char dir[64], path[96], name[32];
	long v;
	int i, k;

	for (i = 0; i < 8; i++) {
		join_path(dir, sizeof(dir) - 1, hwmon_root, "/hwmon0");
		dir[slen(dir) - 1] = (char)('0' + i);
		join_path(path, sizeof(path), dir, "/name");
		if (read_file(path, name, sizeof(name)) > 0 &&
		    spre(name, "rtl9602c_soc") && (name[12] == 0 || name[12] == '\n'))
			break;
	}
	if (i == 8 || read_milli(dir, "/temp1_input", &v) < 0)
		return;

	put_fd(fd, ",\"chip_temp\":{\"celsius\":");
	put_celsius(fd, v);
	for (k = 0; k < 2; k++) {
		join_path(path, sizeof(path), "/temp1_", limits[k]);
		if (read_milli(dir, path, &v) == 0) {
			put_fd(fd, ",\"");
			put_fd(fd, limits[k]);
			put_fd(fd, "\":");
			put_celsius(fd, v);
		}
	}
	for (k = 0; k < 2; k++) {
		join_path(path, sizeof(path), "/temp1_", limits[k]);
		str_copy(path + slen(path), "_alarm", sizeof(path) - slen(path));
		if (read_milli(dir, path, &v) == 0 && (v == 0 || v == 1)) {
			put_fd(fd, ",\"");
			put_fd(fd, limits[k]);
			put_fd(fd, v ? "_alarm\":true" : "_alarm\":false");
		}
	}
	put_fd(fd, "}");
}

/* The text after `prefix` on the line of `buf` that starts with it, and its
 * length in *len; 0 when no line does. */
static const char *find_line(const char *buf, const char *prefix, unsigned long *len)
{
	unsigned long n = slen(prefix), i = 0, e;

	while (buf[i]) {
		for (e = i; buf[e] && buf[e] != '\n'; e++)
			;
		if (e - i >= n && spre(buf + i, prefix)) {
			*len = e - i - n;
			return buf + i + n;
		}
		i = buf[e] ? e + 1 : e;
	}
	return 0;
}

static void emit_member(int fd, const char *name, const char *v, unsigned long len)
{
	put_fd(fd, ",\"");
	put_fd(fd, name);
	put_fd(fd, "\":\"");
	put_json_str(fd, v, len);
	put_fd(fd, "\"");
}

/*
 * What the stick diagram on the Status tab needs beyond diag: the CPU and
 * memory figures, the ONU-ID and the host side of the link. Plain file
 * reads, no fork, so the poll costs no more than it did.
 *
 * Each member is one line of its file, after the prefix that finds it,
 * passed on as a string: the browser parses it, as it does diag output.
 * A file or a line that is not there emits nothing, so a stock slot (no
 * /proc/odi_gpon, no host-link state) shows those blocks without a value.
 */
static void emit_line(int fd, const char *name, const char *path,
		      const char *prefix, char *buf, unsigned long cap)
{
	const char *v;
	unsigned long len;

	if (read_file(path, buf, cap) <= 0)
		return;
	v = find_line(buf, prefix, &len);
	if (v)
		emit_member(fd, name, v, len);
}

/*
 * What the PON load figure is worked out from: the idle GEM frames the OLT
 * sent (a 64-bit total), and the downstream superframe count and FEC bit
 * of the sample that total comes from. One read of counters has all of
 * them, so they belong together; status has the frame count too, but a
 * driver sample between two reads would pair an idle count with a frame
 * count one second ahead of it. A driver without ctr_ds_superframe (odi-oss
 * before it had the line, or a stock slot) emits nothing and the page
 * leaves the section out.
 * ds_gem_idle_sat is how many samples read the idle register full (it is
 * 32 bits, cleared on read, and fills in about 70 s); absent when none did.
 */
static void emit_pon_load(int fd)
{
	/* counters ends with one ctr_saturated line per counter that ever
	 * read full, so it can outgrow the 2 KB the other reads use. */
	char ct[4096];
	const char *sf, *idle, *v;
	unsigned long nsf, nidle, n;

	if (read_file(GPON_COUNTERS, ct, sizeof(ct)) <= 0)
		return;
	sf = find_line(ct, "ctr_ds_superframe ", &nsf);
	idle = find_line(ct, "ctr ds_gem_idle ", &nidle);
	if (!sf || !idle)
		return;
	emit_member(fd, "ds_superframe", sf, nsf);
	emit_member(fd, "ds_gem_idle", idle, nidle);
	v = find_line(ct, "ctr_fec_now ds ", &n);
	if (v)
		emit_member(fd, "ds_fec", v, n);
	v = find_line(ct, "ctr_saturated ds_gem_idle ", &n);
	if (v)
		emit_member(fd, "ds_gem_idle_sat", v, n);
}

/* How long the stick has been up, the whole seconds of /proc/uptime. */
static void emit_uptime(int fd, char *buf, unsigned long cap)
{
	unsigned long k = 0;

	if (read_file(UPTIME_FILE, buf, cap) <= 0)
		return;
	while (buf[k] >= '0' && buf[k] <= '9')
		k++;
	if (k)
		emit_member(fd, "uptime", buf, k);
}

static void emit_overview(int fd)
{
	char buf[2048];

	emit_line(fd, "cpu", PROC_STAT, "cpu ", buf, sizeof(buf));
	emit_line(fd, "mem_total", PROC_MEMINFO, "MemTotal:", buf, sizeof(buf));
	emit_line(fd, "mem_avail", PROC_MEMINFO, "MemAvailable:", buf, sizeof(buf));
	emit_line(fd, "onu_id", GPON_STATUS, "onu_id ", buf, sizeof(buf));
	emit_line(fd, "alloc_ids", GPON_STATUS, "alloc_ids ", buf, sizeof(buf));
	emit_line(fd, "o7_hold", GPON_STATUS, "o7_hold ", buf, sizeof(buf));
	/* How often the ONU entered ranging (O3 to O4) since boot: the link
	 * check tells an OLT that never answers the serial from one that ranges
	 * the ONU and drops it, which a poll every 15 s would mostly miss. */
	emit_line(fd, "o3_o4", GPON_STATUS, "onu_transitions O3 O4 ", buf, sizeof(buf));
	emit_line(fd, "pon_id", GPON_STATUS, "pon_id ", buf, sizeof(buf));
	emit_line(fd, "ranging", GPON_STATUS, "ranging_time ", buf, sizeof(buf));
	emit_line(fd, "host_link", HOSTLINK_LINK, "", buf, sizeof(buf));
	emit_line(fd, "host_mode", SERDES_STATE, "running=", buf, sizeof(buf));
	emit_uptime(fd, buf, sizeof(buf));
	emit_pon_load(fd);
}

/*
 * Device status, in one diag invocation. diag costs ~32 ms to start and almost
 * nothing to run, so every question goes in on stdin at once; see
 * odi-sfp-exporter's notes on the same trick.
 */
void emit_status_json(int fd)
{
	static char *const argv[] = { "diag", 0 };
	static const char script[] =
		"pon get transceiver rx-power\n"
		"pon get transceiver tx-power\n"
		"pon get transceiver temperature\n"
		"pon get transceiver voltage\n"
		"pon get transceiver bias-current\n"
		"gpon get onu-state\n"
		"gpon get alarm-status\n"
		"mib dump counter port all\n"
		"exit\n";

	if (run_script_to_buf(DIAG_PATH, argv, script, status, sizeof(status),
			      DIAG_TIMEOUT_MS) <= 0) {
		put_fd(fd, "{\"error\":\"diag failed\"}");
		return;
	}
	/* Raw for now: the browser splits on the RTK.0> prompt. Keeping the
	 * parsing on that side means adding a status field costs no C. */
	put_fd(fd, "{\"raw\":\"");
	put_json_cstr(fd, status);
	put_fd(fd, "\"");
	emit_chip_temp(fd);
	emit_overview(fd);
	put_fd(fd, "}");
}

/*
 * The switch's learned MAC addresses.
 *
 * Its own route rather than another line in the status scrape, for one reason:
 * size. The status buffer is 16 KB and the counter dump alone is 5.9 KB, while
 * this table grows with every host that has talked through the stick -- a few
 * hundred entries would push the optics and the ONU state out of the response
 * and break the page that is always on screen to improve one that is not.
 *
 * What it answers is the other half of the Forwarding section. Those counters
 * say whether frames cross; this says which side each MAC was learned on, which
 * is what tells you a host is reachable through the fibre rather than only
 * talking to the stick.
 */
void emit_l2_json(int fd)
{
	/*
	 * ARGUMENTS, not stdin -- and this is not a style choice.
	 *
	 * Fed `l2-table get entry address valid` on stdin, diag never returns:
	 * measured on a stick at 100% CPU in state R until killed, taking this
	 * single-threaded daemon down with it because every other request then
	 * queues behind a child that will not exit. The identical command as
	 * argv returns immediately.
	 *
	 * emit_status_json above still batches on stdin and is right to: its
	 * `pon get` / `gpon get` / `mib dump` commands all terminate that way,
	 * and one invocation for seven questions is worth ~200 ms. The lesson
	 * is per command, not general -- so a new diag command goes through
	 * argv until it has been shown to terminate on stdin.
	 *
	 * The odi-oss diag answers the same argv with its own listing (its
	 * stock-spelling alias of `l2-table get all`), so one confd serves both
	 * slots with this one command.
	 */
	static char *const argv[] = { "diag", "l2-table", "get", "entry",
				      "address", "valid", 0 };
	long got, code = -1;

	got = run_to_buf_ex(DIAG_PATH, argv, omci, sizeof(omci), &code, DIAG_TIMEOUT_MS);
	if (got <= 0) {
		put_fd(fd, "{\"error\":\"diag failed\"}");
		return;
	}
	put_fd(fd, "{\"raw\":\"");
	put_json_cstr(fd, omci);
	put_fd(fd, "\",\"truncated\":");
	put_fd(fd, ((unsigned long)got + 1 >= sizeof(omci)) ? "true" : "false");
	put_fd(fd, "}");
}

/*
 * The kernel ring buffer.
 *
 * This device keeps no other log: there is no syslogd in the image and no
 * dmesg applet in its busybox, so the only record of what the switch and the
 * OMCI stack complained about is in here until it scrolls away. It is where
 * `create ani vlan for mbcast fail` and `RT_ERR_RG_VLAN_USED_BY_SYSTEM` show
 * up -- the symptoms of an OMCI_OLT_MODE nobody should be using -- and nothing
 * in this UI looked at it before.
 *
 * klogctl rather than /proc/kmsg: reading that file consumes the buffer and
 * then blocks waiting for more, so a page refresh would both eat the history
 * and hang the server, which is single-threaded.
 */
void emit_log_json(int fd)
{
	long got = read_klog(omci, sizeof(omci));

	if (got < 0) {
		put_fd(fd, "{\"error\":\"the kernel would not hand over its log buffer\"}");
		return;
	}
	put_fd(fd, "{\"raw\":\"");
	put_json_cstr(fd, omci);
	put_fd(fd, "\",\"truncated\":");
	/* The ring buffer is usually smaller than this, but say so when it is
	 * not: the OLDEST lines are what klogctl drops, so a silently short
	 * answer looks like a device that has been quiet. */
	put_fd(fd, ((unsigned long)got + 1 >= sizeof(omci)) ? "true" : "false");
	put_fd(fd, "}");
}

/*
 * GET /api/diag: the diagnostics bundle, as a download.
 *
 * The image script does all the collecting and all the redacting, and
 * writes DIAG_BUNDLE_OUT; this runs it, bounded, and streams the file. A
 * failure is an HTTP error with the script own message, never a 200 with a
 * partial archive: a browser saves whatever a 200 carries. Without the
 * script (a stock slot, an older odi-oss) the route answers 501.
 *
 * Streamed in filebuf-sized chunks, capped at DIAG_BUNDLE_MAX, and the
 * file is removed afterwards so the next request cannot be handed a stale
 * one. The socket has SO_SNDTIMEO (main.c), so a client that stops reading
 * cannot hold the daemon either.
 */
void emit_diag_bundle(int fd)
{
	static char *const argv[] = { "diag-bundle.sh", DIAG_BUNDLE_OUT, 0 };
	long got, code = -1, in;
	unsigned long sent = 0;

	if (!file_exists(DIAG_BUNDLE_SCRIPT)) {
		respond(fd, "501 Not Implemented", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"this image has no " DIAG_BUNDLE_SCRIPT "\"}");
		return;
	}

	got = run_to_buf_ex(DIAG_BUNDLE_SCRIPT, argv, status, sizeof(status), &code,
			    DIAG_BUNDLE_TIMEOUT_MS);
	if (got == -2 || code != 0) {
		syscall3(__NR_unlink, (long)DIAG_BUNDLE_OUT, 0, 0);
		respond(fd, "500 Internal Server Error", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"");
		put_fd(fd, got == -2 ? "diag-bundle.sh did not finish in time"
				     : "diag-bundle.sh failed");
		put_fd(fd, "\",\"output\":\"");
		if (got > 0)
			put_json_cstr(fd, status);
		put_fd(fd, "\"}");
		return;
	}

	in = syscall3(__NR_open, (long)DIAG_BUNDLE_OUT, O_RDONLY, 0);
	if (in < 0) {
		respond(fd, "500 Internal Server Error", "application/json", 0);
		put_fd(fd, "{\"ok\":false,\"error\":\"diag-bundle.sh wrote no " DIAG_BUNDLE_OUT "\"}");
		return;
	}

	respond(fd, "200 OK", "application/gzip",
		"Content-Disposition: attachment; filename=\"odi-diag.tar.gz\"\r\n");
	while (sent < DIAG_BUNDLE_MAX) {
		unsigned long want = sizeof(filebuf);
		long n;

		if (want > DIAG_BUNDLE_MAX - sent)
			want = DIAG_BUNDLE_MAX - sent;
		n = syscall3(__NR_read, in, (long)filebuf, (long)want);
		if (n <= 0)
			break;
		if (write_all(fd, filebuf, (unsigned long)n) != n)
			break;		/* the client went away, or stopped reading */
		sent += (unsigned long)n;
	}
	syscall3(__NR_close, in, 0, 0);
	syscall3(__NR_unlink, (long)DIAG_BUNDLE_OUT, 0, 0);
}
