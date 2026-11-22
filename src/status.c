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

/*
 * The fibre port octet counters, straight from the switch driver: ioctl
 * MIB_GET on /dev/odi_sw, the call our own diag makes, so no fork. Port 2 is
 * the PON port, counter is the diag index 0 (ifInOctets) or 5 (ifOutOctets).
 * The request is _IOWR('S', 4, struct odi_sw_mib): MIPS builds the direction
 * bits as read 2 and write 4, which for read plus write gives the same number
 * as the generic header, 0xC0105304 (odi-oss odi_reg.h has the same value).
 * The struct is 16 bytes with the 64-bit value at offset 8; the kernel reads
 * the counter consistently. A plain open and MIB_GET take no lease.
 */
#define ODI_SW_IOC_MIB_GET 0xC0105304UL
#define ODI_PON_PORT       2
#define ODI_MIB_IN_OCTETS  0
#define ODI_MIB_OUT_OCTETS 5

struct odi_sw_mib {
	unsigned int port;
	unsigned int counter;
	unsigned long long value;
};

/* The 64-bit value as decimal text, without a 64-bit division (the build
 * has no libgcc helper for it): four 16-bit limbs, divided by ten per digit. */
static unsigned long u64_dec(char *out, unsigned long long v)
{
	unsigned long limb[4], i, n = 0, k;
	char tmp[21];

	for (i = 0; i < 4; i++)
		limb[i] = (unsigned long)((v >> (16 * (3 - i))) & 0xffff);
	do {
		unsigned long rem = 0;

		for (i = 0; i < 4; i++) {
			unsigned long cur = (rem << 16) | limb[i];

			limb[i] = cur / 10;
			rem = cur % 10;
		}
		tmp[n++] = (char)('0' + rem);
	} while ((limb[0] | limb[1] | limb[2] | limb[3]) && n < sizeof(tmp));
	for (k = 0; k < n; k++)
		out[k] = tmp[n - 1 - k];
	out[n] = 0;
	return n;
}

/* One counter, or 0 when the ioctl failed. */
static int sw_mib_get(long dev, unsigned int counter, unsigned long long *v)
{
	struct odi_sw_mib m;

	m.port = ODI_PON_PORT;
	m.counter = counter;
	m.value = 0;
	if (syscall3(__NR_ioctl, dev, (long)ODI_SW_IOC_MIB_GET, (long)&m) != 0)
		return 0;
	*v = m.value;
	return 1;
}

/* pon_in_octets and pon_out_octets, both or neither: a stock slot has no
 * /dev/odi_sw, and a failed read leaves the page on the 15 s figure. */
static void emit_pon_octets(int fd)
{
	unsigned long long in = 0, out = 0;
	char num[21];
	long dev;
	int good;

	dev = syscall3(__NR_open, (long)ODI_SW_DEV, O_RDONLY, 0);
	if (dev < 0)
		return;
	good = sw_mib_get(dev, ODI_MIB_IN_OCTETS, &in)
	       && sw_mib_get(dev, ODI_MIB_OUT_OCTETS, &out);
	syscall3(__NR_close, dev, 0, 0);
	if (!good)
		return;
	emit_member(fd, "pon_in_octets", num, u64_dec(num, in));
	emit_member(fd, "pon_out_octets", num, u64_dec(num, out));
}

/*
 * GET /api/ponload: the PON load members of /api/status and nothing else,
 * for the page to refresh that one figure between status polls. Two file
 * reads and no fork, so it is cheap enough to ask for every second; the
 * driver takes a new sample once a second, so asking more often gains
 * nothing. `onu_state` is the driver's "state" line ("5 (O5)"), so the page
 * can stop showing a figure as soon as the line leaves O5 rather than at the
 * next status poll. `pon_in_octets` and `pon_out_octets` are the PON port
 * byte counters from the switch driver (two ioctls, no fork), for the rates
 * on the fibre line. The two groups are independent: a stick with one and
 * not the other answers with the one it has, and with neither it answers
 * {"ok":true} alone.
 */
void emit_ponload_json(int fd)
{
	char buf[2048];

	put_fd(fd, "{\"ok\":true");
	emit_line(fd, "onu_state", GPON_STATUS, "state ", buf, sizeof(buf));
	emit_pon_load(fd);
	emit_pon_octets(fd);
	put_fd(fd, "}");
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

/*
 * The "previous boot:" line of /proc/odi_ramlog_prev, after the prefix. It
 * cannot change while this boot runs, so it is read once: the kernel renders
 * the whole 8 KB copy on every open, and the status poll runs every few
 * seconds. Nothing is written anywhere; a power cut empties the pages and the
 * kernel says so itself (reason=power). A stock slot has no file, and the
 * member is then missing.
 */
static void emit_prev_boot(int fd, char *buf, unsigned long cap)
{
	static char line[PREV_BOOT_MAX];
	static unsigned long n;
	static int read_once;
	const char *v;
	unsigned long len, k;

	if (!read_once) {
		read_once = 1;
		if (read_file(RAMLOG_PREV, buf, cap) > 0 &&
		    (v = find_line(buf, "previous boot: ", &len)) != 0) {
			if (len > sizeof(line))
				len = sizeof(line);
			for (k = 0; k < len; k++)
				line[k] = v[k];
			n = len;
		}
	}
	if (n)
		emit_member(fd, "prev_boot", line, n);
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
	/* Whole seconds in the current ONU state, on the monotonic clock: in
	 * O5, how long the line has been up, which a pulled fibre restarts. */
	emit_line(fd, "in_state_s", GPON_STATUS, "in_state_s ", buf, sizeof(buf));
	/* How often the ONU entered ranging (O3 to O4) since boot: the link
	 * check tells an OLT that never answers the serial from one that ranges
	 * the ONU and drops it, which a poll every 15 s would mostly miss. */
	emit_line(fd, "o3_o4", GPON_STATUS, "onu_transitions O3 O4 ", buf, sizeof(buf));
	emit_line(fd, "pon_id", GPON_STATUS, "pon_id ", buf, sizeof(buf));
	emit_line(fd, "ranging", GPON_STATUS, "ranging_time ", buf, sizeof(buf));
	emit_line(fd, "host_link", HOSTLINK_LINK, "", buf, sizeof(buf));
	emit_line(fd, "host_mode", SERDES_STATE, "running=", buf, sizeof(buf));
	emit_uptime(fd, buf, sizeof(buf));
	emit_prev_boot(fd, buf, sizeof(buf));
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
 * The kernel log is where `create ani vlan for mbcast fail` and
 * `RT_ERR_RG_VLAN_USED_BY_SYSTEM` show up -- the symptoms of an OMCI_OLT_MODE
 * nobody should be using -- along with the rcS and respawn lines odi-oss
 * writes to /dev/kmsg. The stock image has no syslogd and no dmesg applet, so
 * there it is the only log at all.
 *
 * Two ways in. On a kernel that has it (3.5 and later, so the odi-oss 6.18
 * one), /dev/kmsg hands over one record per read(), each with its time in
 * microseconds since boot, whether or not CONFIG_PRINTK_TIME put a time in the
 * text (the odi-oss kernel does not). Every opener gets its own position, so
 * reading it consumes nothing, and O_NONBLOCK ends the walk with EAGAIN at the
 * newest record instead of waiting for the next one. On the stock 2.6.30
 * kernel /dev/kmsg is write-only, and klogctl(READ_ALL) is the way, as before.
 * Never /proc/kmsg: reading that file consumes the buffer and then blocks
 * waiting for more, so a page refresh would both eat the history and hang the
 * server, which is single-threaded.
 *
 * `raw` is the same text either way, `<prio>` and the message on each line;
 * the /dev/kmsg path adds `lines`, one {p, us, msg} per record, and the two
 * clocks the page needs to turn `us` into a time of day.
 */
#define KMSG_PATH        "/dev/kmsg"
#define O_NONBLOCK_MIPS  0x80
#define EPIPE_ERR        32
/* A bound on the walk: a stick's 16 KB buffer is a few hundred records, a
 * development host's can be far more, and the store below keeps the newest. */
#define KMSG_MAX_READS   65536

/* Digits only, at least one, at most `max`. */
static int all_digits(const char *s, unsigned long n, unsigned long max)
{
	unsigned long i;

	if (n == 0 || n > max)
		return 0;
	for (i = 0; i < n; i++)
		if (s[i] < '0' || s[i] > '9')
			return 0;
	return 1;
}

/*
 * One /dev/kmsg record, "prio,seq,usec,flags[,...];text\n" with dictionary
 * lines (" KEY=value\n") after it, stored as "prio,usec;text\0". The kernel
 * escapes every byte below a space, at or above 127, and the backslash as
 * \xNN; those come back as the byte (a NUL is dropped), so a message that
 * held a newline reads as it did through klogctl. Returns the stored length,
 * 0 when `rec` is not a record (the caller then knows this is not a kernel
 * that speaks the format), or -1 when it would not fit in `cap`.
 */
static long kmsg_store(const char *rec, unsigned long n, char *out, unsigned long cap)
{
	unsigned long f[4], i = 0, k = 0, o = 0, semi;

	f[0] = 0;
	while (i < n && rec[i] != ';' && rec[i] != '\n') {
		if (rec[i] == ',' && k < 3)
			f[++k] = i + 1;
		i++;
	}
	if (i >= n || rec[i] != ';' || k < 2)
		return 0;
	semi = i;
	/* prio and usec, the first and third fields */
	if (!all_digits(rec, f[1] - 1, 4))
		return 0;
	{
		unsigned long ue = f[2];

		while (ue < semi && rec[ue] != ',')
			ue++;
		if (!all_digits(rec + f[2], ue - f[2], 20))
			return 0;
		if (f[1] - 1 + 1 + (ue - f[2]) + 1 + 1 > cap)
			return -1;
		for (i = 0; i < f[1] - 1; i++)
			out[o++] = rec[i];
		out[o++] = ',';
		for (i = f[2]; i < ue; i++)
			out[o++] = rec[i];
		out[o++] = ';';
	}
	for (i = semi + 1; i < n && rec[i] != '\n'; i++) {
		char c = rec[i];

		if (c == '\\' && i + 3 < n && rec[i + 1] == 'x'
		    && hexval(rec[i + 2]) >= 0 && hexval(rec[i + 3]) >= 0) {
			c = (char)(hexval(rec[i + 2]) * 16 + hexval(rec[i + 3]));
			i += 3;
			if (!c)
				continue;
		}
		if (o + 2 > cap)
			return -1;
		out[o++] = c;
	}
	out[o++] = 0;
	return (long)o;
}

/*
 * Every record /dev/kmsg holds, oldest first, into `omci`. Returns the bytes
 * stored, or -1 when this kernel does not offer the record format (the caller
 * falls back to klogctl). *dropped is set when the store filled and the oldest
 * records were let go to keep the newest.
 */
static long read_kmsg(int *dropped)
{
	char *rec = status;	/* one record at a time; nothing else is using it */
	unsigned long len = 0, cap = sizeof(omci), reads = 0;
	long fd = syscall3(__NR_open, (long)KMSG_PATH, O_RDONLY | O_NONBLOCK_MIPS, 0);
	int any = 0;

	*dropped = 0;
	if (fd < 0)
		return -1;
	while (reads++ < KMSG_MAX_READS) {
		long n = syscall3(__NR_read, fd, (long)rec, sizeof(status) - 1);
		long got;

		if (n == -EPIPE_ERR) {
			/* Records were overwritten under us; the next read
			 * starts at the oldest one still there. */
			*dropped = 1;
			continue;
		}
		if (n == -EAGAIN_MIPS || n == 0)
			break;
		if (n < 0) {
			/* EINVAL from a kernel whose /dev/kmsg cannot be read */
			if (!any) {
				syscall3(__NR_close, fd, 0, 0);
				return -1;
			}
			break;
		}
		got = kmsg_store(rec, (unsigned long)n, omci + len, cap - len);
		if (got == 0) {
			if (!any) {
				syscall3(__NR_close, fd, 0, 0);
				return -1;
			}
			continue;
		}
		any = 1;
		if (got < 0) {
			/* Full: let go of the oldest half and store this one
			 * again. A record never comes near half of the store. */
			unsigned long cut = len / 2, j;

			while (cut < len && omci[cut])
				cut++;
			if (cut < len)
				cut++;
			for (j = cut; j < len; j++)
				omci[j - cut] = omci[j];
			len -= cut;
			*dropped = 1;
			got = kmsg_store(rec, (unsigned long)n, omci + len, cap - len);
			if (got <= 0)
				continue;
		}
		len += (unsigned long)got;
	}
	syscall3(__NR_close, fd, 0, 0);
	return any ? (long)len : (reads > 1 ? 0 : -1);
}

/* sec.nsec as whole microseconds, written as digits: no 64-bit arithmetic,
 * which this freestanding build has no helpers for. */
static void put_us_fd(int fd, long sec, long nsec)
{
	unsigned long us = (unsigned long)nsec / 1000UL, div;

	if (sec <= 0) {
		put_u32_fd(fd, us);
		return;
	}
	put_u32_fd(fd, (unsigned long)sec);
	for (div = 100000UL; div; div /= 10) {
		char d = (char)('0' + (us / div) % 10);

		write_all(fd, &d, 1);
	}
}

/*
 * Whether ntpd has set the clock since it started: /tmp/ntp-status (written
 * by the odi-oss ntpd hook, removed whenever ntpd is not running) names the
 * time of the last sync in last_sync, empty until the first one. An unsync
 * event keeps it, and a clock once set stays close enough for a log.
 */
static int clock_synced(void)
{
	char buf[256];
	long got = read_file(NTP_STATUS_FILE, buf, sizeof(buf));
	unsigned long i = 0;

	if (got <= 0)
		return 0;
	while (buf[i]) {
		unsigned long le = i, k = 0;

		while (buf[le] && buf[le] != '\n')
			le++;
		while (k < 10 && i + k < le && buf[i + k] == "last_sync="[k])
			k++;
		if (k == 10)
			return all_digits(buf + i + 10, le - i - 10, 20);
		i = buf[le] ? le + 1 : le;
	}
	return 0;
}

/* The fields of the stored record at omci[i]: prio is omci[i..*c), usec
 * (*c..*semi), the text (*semi..*e); the next record starts at *e + 1. */
static void kmsg_fields(unsigned long i, unsigned long *c, unsigned long *semi,
			unsigned long *e)
{
	*c = i;
	while (omci[*c] != ',')
		(*c)++;
	*semi = *c;
	while (omci[*semi] != ';')
		(*semi)++;
	*e = *semi + 1;
	while (omci[*e])
		(*e)++;
}

static void emit_kmsg_json(int fd, unsigned long len, int dropped)
{
	long mono[2], wall[2];
	unsigned long i, c, semi, e;

	put_fd(fd, "{\"raw\":\"");
	for (i = 0; i < len; i = e + 1) {
		kmsg_fields(i, &c, &semi, &e);
		put_fd(fd, "<");
		write_all(fd, omci + i, c - i);
		put_fd(fd, ">");
		put_json_str(fd, omci + semi + 1, e - semi - 1);
		put_fd(fd, "\\n");
	}
	put_fd(fd, "\",\"truncated\":");
	put_fd(fd, dropped ? "true" : "false");
	put_fd(fd, ",\"lines\":[");
	for (i = 0; i < len; i = e + 1) {
		kmsg_fields(i, &c, &semi, &e);
		put_fd(fd, i ? ",{\"p\":" : "{\"p\":");
		write_all(fd, omci + i, c - i);
		put_fd(fd, ",\"us\":");
		write_all(fd, omci + c + 1, semi - c - 1);
		put_fd(fd, ",\"msg\":\"");
		put_json_str(fd, omci + semi + 1, e - semi - 1);
		put_fd(fd, "\"}");
	}
	put_fd(fd, "],\"synced\":");
	put_fd(fd, clock_synced() ? "true" : "false");
	/* The two clocks, read back to back, last in the object: the page
	 * dates a record as now - (uptime - us). */
	if (syscall3(__NR_clock_gettime, CLOCK_MONOTONIC, (long)mono, 0) >= 0
	    && syscall3(__NR_clock_gettime, CLOCK_REALTIME, (long)wall, 0) >= 0) {
		put_fd(fd, ",\"uptime_us\":");
		put_us_fd(fd, mono[0], mono[1]);
		put_fd(fd, ",\"now_us\":");
		put_us_fd(fd, wall[0], wall[1]);
	}
	put_fd(fd, "}");
}

void emit_log_json(int fd)
{
	int dropped;
	long got = read_kmsg(&dropped);

	if (got >= 0) {
		emit_kmsg_json(fd, (unsigned long)got, dropped);
		return;
	}
	got = read_klog(omci, sizeof(omci));
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
