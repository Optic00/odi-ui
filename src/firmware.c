/*
 * Boot selection and the firmware view.
 */

#include "confd.h"
#include "http.h"
#include "firmware.h"
#include "buffers.h"
#include "uimage.h"

/*
 * Boot selection.
 *
 * U-Boot keeps a one-shot trial slot, and using it is the difference between an
 * experiment and a site visit. Setting sw_tryactive boots a partition ONCE with
 * the watchdog armed; if the image does not come up, the next boot returns to
 * whatever sw_commit names, unattended. A trial that boots fine still reverts on
 * the following reboot, so keeping an image is a separate deliberate act.
 *
 * The obvious-looking alternative — writing sw_commit straight away — makes an
 * unproven image permanent before it has booted even once, and is what every
 * runbook for this device used to say.
 *
 * sw_active is U-Boot's own record of what it last booted. It is written by the
 * bootloader on every boot and is never set here.
 */
/* How much of the flasher's output /api/firmware carries: enough for the
 * last dozen lines, which say where it is and whether it failed. */
#define FWU_LOG_TAIL 1600

const char *confd_exe = "";

/*
 * What each slot actually holds, read off its kernel partition.
 *
 * U-Boot sw_version<p> is only what the last updater chose to record there:
 * odi-oss fwu.sh records nothing unless asked, and the stock one records
 * whatever its tarball says. On a live stick it named an odi-oss build for
 * the slot holding the stock firmware. The uImage header in k<p> is written
 * by the flash itself, so it cannot drift from the image: its name field
 * ("Linux Kernel Image" on the stock base, "Linux Kernel Image 6.18" on
 * odi-oss) and its build time are what the page judges a slot by.
 *
 * 64 bytes, read with read(2) from the mtd character device: no child, no
 * wait on another process, nothing to bound. The partition index comes from
 * /proc/mtd by name, never assumed.
 */
static int mtd_index(const char *mtds, const char *name)
{
	unsigned long i = 0;

	while (mtds[i]) {
		unsigned long ls = i, q;

		while (mtds[i] && mtds[i] != '\n')
			i++;
		/* mtd4: 00148000 00010000 "k0" */
		if (spre(mtds + ls, "mtd")) {
			for (q = ls; q < i && mtds[q] != '"'; q++)
				;
			if (q < i && spre(mtds + q + 1, name)
			    && mtds[q + 1 + str_len(name)] == '"') {
				int n = 0;

				for (q = ls + 3; mtds[q] >= '0' && mtds[q] <= '9'; q++)
					n = n * 10 + (mtds[q] - '0');
				return n;
			}
		}
		if (mtds[i] == '\n')
			i++;
	}
	return -1;
}

/* The size of the partition `name`, in bytes, from the same /proc/mtd text
 * (hex, the second field), or 0. */
static unsigned long mtd_size(const char *mtds, const char *name)
{
	unsigned long i = 0;

	while (mtds[i]) {
		unsigned long ls = i, q;

		while (mtds[i] && mtds[i] != '\n')
			i++;
		if (spre(mtds + ls, "mtd")) {
			for (q = ls; q < i && mtds[q] != '"'; q++)
				;
			if (q < i && spre(mtds + q + 1, name)
			    && mtds[q + 1 + str_len(name)] == '"') {
				unsigned long v = 0;

				for (q = ls; q < i && mtds[q] != ':'; q++)
					;
				for (q++; q < i && mtds[q] == ' '; q++)
					;
				for (; q < i; q++) {
					char c = mtds[q];

					if (c >= '0' && c <= '9')
						v = v * 16 + (unsigned long)(c - '0');
					else if (c >= 'a' && c <= 'f')
						v = v * 16 + (unsigned long)(c - 'a') + 10;
					else
						break;
				}
				return v;
			}
		}
		if (mtds[i] == '\n')
			i++;
	}
	return 0;
}

/*
 * 1 when the kernel partition k<p> holds a uImage that U-Boot would boot: the
 * magic, the header CRC and the data CRC all hold (what bootm checks first).
 * An erased slot, one whose flash was cut short (the flasher writes the kernel
 * last, so a short write leaves it incomplete) and one holding something that
 * is not a uImage all fail. Reads the kernel partition once, through filebuf,
 * 64 KB at a time, with no child process; about 1.3 MB, a fraction of a second.
 */
int slot_kernel_ok(char p)
{
	char part[3] = { 'k', p, 0 };
	char dev[16] = "/dev/mtd";
	char mtds[1024];
	unsigned long n = 8, size, left, cap;
	unsigned int crc = 0, want;
	long fd, got;
	int idx;

	if (read_file("/proc/mtd", mtds, sizeof(mtds)) <= 0)
		return 0;
	idx = mtd_index(mtds, part);
	cap = mtd_size(mtds, part);
	if (idx < 0 || idx > 99 || !cap)
		return 0;
	if (idx >= 10)
		dev[n++] = (char)('0' + idx / 10);
	dev[n++] = (char)('0' + idx % 10);
	dev[n] = 0;
	fd = syscall3(__NR_open, (long)dev, O_RDONLY, 0);
	if (fd < 0)
		return 0;
	/* The header: read(2) on an mtd character device may return less. */
	for (n = 0; n < UIMAGE_HDR_LEN;) {
		got = syscall3(__NR_read, fd, (long)(filebuf + n), (long)(UIMAGE_HDR_LEN - n));
		if (got <= 0) {
			syscall3(__NR_close, fd, 0, 0);
			return 0;
		}
		n += (unsigned long)got;
	}
	size = uimage_header_ok((const unsigned char *)filebuf, cap);
	want = uimage_be32((const unsigned char *)filebuf + 24);
	if (!size) {
		syscall3(__NR_close, fd, 0, 0);
		return 0;
	}
	for (left = size; left;) {
		unsigned long chunk = left < sizeof(filebuf) ? left : sizeof(filebuf);

		got = syscall3(__NR_read, fd, (long)filebuf, (long)chunk);
		if (got <= 0) {
			syscall3(__NR_close, fd, 0, 0);
			return 0;
		}
		crc = uimage_crc32(crc, (const unsigned char *)filebuf, (unsigned long)got);
		left -= (unsigned long)got;
	}
	syscall3(__NR_close, fd, 0, 0);
	return crc == want;
}

static void emit_slot(int fd, const char *mtds, char p)
{
	char part[3] = { 'k', p, 0 };
	char dev[16] = "/dev/mtd";
	unsigned char h[65];
	int idx = mtd_index(mtds, part);
	unsigned long n = 8, k;
	unsigned long t;

	put_fd(fd, "\"");
	write_all(fd, &p, 1);
	put_fd(fd, "\":{");
	if (idx < 0 || idx > 99)
		goto done;
	if (idx >= 10)
		dev[n++] = (char)('0' + idx / 10);
	dev[n++] = (char)('0' + idx % 10);
	dev[n] = 0;
	if (read_file(dev, (char *)h, sizeof(h)) != 64)
		goto done;
	/* IH_MAGIC, big-endian: anything else is not a uImage, and saying
	 * nothing is more honest than a guess. */
	if (h[0] != 0x27 || h[1] != 0x05 || h[2] != 0x19 || h[3] != 0x56)
		goto done;
	t = ((unsigned long)h[8] << 24) | ((unsigned long)h[9] << 16)
	  | ((unsigned long)h[10] << 8) | h[11];
	for (k = 32; k < 64 && h[k] >= 0x20 && h[k] < 0x7f; k++)
		;
	put_fd(fd, "\"kernel\":\"");
	put_json_str(fd, (const char *)h + 32, k - 32);
	put_fd(fd, "\",\"built\":");
	{
		char num[12];
		unsigned long m = 0;

		if (!t)
			num[m++] = '0';
		while (t) {
			num[m++] = (char)('0' + t % 10);
			t /= 10;
		}
		while (m)
			write_all(fd, &num[--m], 1);
	}
done:
	put_fd(fd, "}");
}

/*
 * Whether an `nv fallback` answer is one to go by. Three are:
 *   - exit 0 (a value, a dump, or the key not set in that copy), when it
 *     fit the buffer: a full one may have cut what the caller looks for;
 *   - exit 1 with the exact line odi-oss nv prints for no valid second
 *     copy;
 *   - exit 1 with the usage text of an nv without the verb, whose first
 *     line is "Usage: nv getenv [parameter_name]". That says nothing about
 *     a second copy, only that this nv cannot tell, and the write it then
 *     allows is the one a stick without the verb always had.
 * Anything else (no answer in time, killed by a signal, exit 3 for a
 * copy odi-oss nv could not read in full, another status or other words)
 * is no knowing, not "no fallback copy".
 */
static int nv_fallback_known(long got, long code, const char *buf, unsigned long cap)
{
	/* A NUL in the answer hides what follows it from every test below. */
	if (got < 0 || (unsigned long)got != str_len(buf))
		return 0;
	if (code == 0)
		return (unsigned long)got + 1 < cap;
	if (code != 1)
		return 0;
	return seq(buf, "nv: no valid second copy of the environment\n") ||
	       spre(buf, "Usage: nv getenv [parameter_name]\n");
}

/*
 * Whether a full `nv fallback` dump that exited 0 is one, in the shape odi-oss
 * nv prints it: its header line for the copy, then whole name=value lines, then
 * one empty line and nothing after it, with no NUL anywhere; and at most one
 * sw_commit, which names slot 0 or 1. Anything else is no knowing what that
 * copy says, as on the write route, which asks for sw_commit alone (nv_read).
 */
static int nv_fallback_dump_ok(const char *buf, long got)
{
	unsigned long i = 24;            /* past "Fallback environment: N\n" */
	int commits = 0;

	if (got < 0 || (unsigned long)got != str_len(buf))
		return 0;
	if (!spre(buf, "Fallback environment: 1\n") && !spre(buf, "Fallback environment: 2\n"))
		return 0;
	for (;;) {
		unsigned long le = i, eq = i;

		while (buf[le] && buf[le] != '\n')
			le++;
		if (buf[le] != '\n')
			return 0;                /* a last line without its end */
		if (le == i)
			return buf[le + 1] == 0;     /* the empty line ends it */
		while (eq < le && buf[eq] != '=')
			eq++;
		if (eq == i || eq == le)
			return 0;                /* not name=value */
		if (spre(buf + i, "sw_commit=") &&
		    (++commits > 1 || le != i + 11 || (buf[i + 10] != '0' && buf[i + 10] != '1')))
			return 0;
		i = le + 1;
	}
}

/* The sw_* lines of an `nv getenv` / `nv fallback` dump, as JSON members. */
static void emit_sw_pairs(int fd, const char *buf)
{
	unsigned long i = 0;
	int first = 1;

	while (buf[i]) {
		unsigned long ls = i, le = i, eq;

		while (buf[le] && buf[le] != '\n')
			le++;
		if (!spre(buf + ls, "sw_"))
			goto next;
		eq = ls;
		while (eq < le && buf[eq] != '=')
			eq++;
		if (eq == le)
			goto next;
		if (!first)
			put_fd(fd, ",");
		first = 0;
		put_fd(fd, "\"");
		put_json_str(fd, buf + ls, eq - ls);
		put_fd(fd, "\":\"");
		put_json_str(fd, buf + eq + 1, le - eq - 1);
		put_fd(fd, "\"");
next:
		i = (buf[le] == '\n') ? le + 1 : le;
	}
}

/*
 * The address in confirm-arp, copied to out, or "" when the content is not a
 * dotted IPv4 address. Blanks around it and a trailing newline are accepted;
 * anything else (a name, a fifth octet, a value over 255, a leading zero,
 * text after the address) is not an address, so the page never shows odd
 * bytes and the JSON needs no escaping.
 */
static void confirm_arp_addr(const char *buf, char *out, unsigned long cap)
{
	unsigned long i = 0, from, n;
	int oct;

	out[0] = 0;
	while (buf[i] == ' ' || buf[i] == '\t')
		i++;
	from = i;
	for (oct = 0; oct < 4; oct++) {
		unsigned long start = i, v = 0;

		while (buf[i] >= '0' && buf[i] <= '9' && i - start < 4) {
			v = v * 10 + (unsigned long)(buf[i] - '0');
			i++;
		}
		if (i == start || i - start > 3 || v > 255 || (buf[start] == '0' && i - start > 1))
			return;
		if (oct < 3) {
			if (buf[i] != '.')
				return;
			i++;
		}
	}
	n = i - from;
	while (buf[i] == ' ' || buf[i] == '\t' || buf[i] == '\r' || buf[i] == '\n')
		i++;
	if (buf[i] || n + 1 > cap)
		return;
	for (i = 0; i < n; i++)
		out[i] = buf[from + i];
	out[n] = 0;
}

/*
 * The two development files, as plain file reads. dev_confirm_arp is absent
 * when the file is absent, the address when it holds one, and "" when the
 * file exists without a valid address; dev_breadcrumbs is true only when its
 * file exists.
 */
static void emit_dev_files(int fd)
{
	char raw[64], addr[20];

	if (file_exists(CONFIRM_ARP_PATH)) {
		if (read_file(CONFIRM_ARP_PATH, raw, sizeof(raw)) < 0)
			raw[0] = 0;
		confirm_arp_addr(raw, addr, sizeof(addr));
		put_fd(fd, ",\"dev_confirm_arp\":\"");
		put_fd(fd, addr);
		put_fd(fd, "\"");
	}
	if (file_exists(BREADCRUMBS_PATH))
		put_fd(fd, ",\"dev_breadcrumbs\":true");
}

void emit_firmware_json(int fd)
{
	respond(fd, "200 OK", "application/json", 0);
	emit_firmware_body(fd);
}

/* The object alone, without a response head: /api/init carries it too. */
void emit_firmware_body(int fd)
{
	static char *const argv[] = { "nv", "getenv", 0 };
	char buf[4096];
	char ver[128];

	put_fd(fd, "{\"running\":\"");
	if (read_file("/etc/version", ver, sizeof(ver)) > 0) {
		unsigned long n = 0;

		while (ver[n] && ver[n] != '\n' && ver[n] != ' ')
			n++;
		put_json_str(fd, ver, n);
	}
	put_fd(fd, "\",\"mem\":\"");
	{
		/* Total RAM, so the upload note can state the real figure rather
		 * than a number baked into the page. */
		char mi[256];
		unsigned long k;

		if (read_file("/proc/meminfo", mi, sizeof(mi)) > 0) {
			for (k = 0; mi[k]; k++) {
				if (!spre(mi + k, "MemTotal:"))
					continue;
				k += 9;
				while (mi[k] == ' ')
					k++;
				{
					unsigned long e = k;

					while (mi[e] && mi[e] != ' ' && mi[e] != '\n')
						e++;
					/* kB -> MB, integer, good enough for a note */
					{
						unsigned long v = 0, q;

						for (q = k; q < e; q++)
							v = v * 10 + (unsigned long)(mi[q] - '0');
						v /= 1024;
						{
							char num[8];
							unsigned long n = 0;

							if (!v)
								num[n++] = '0';
							while (v) {
								num[n++] = (char)('0' + v % 10);
								v /= 10;
							}
							while (n)
								write_all(fd, &num[--n], 1);
						}
					}
				}
				break;
			}
		}
	}
	put_fd(fd, " MB\",\"env\":{");
	{
		/* Only from an nv that exited 0: what one that then failed
		 * printed, exit 3 included, is not the environment. */
		long code = -1;

		if (run_to_buf_ex("/bin/nv", argv, buf, sizeof(buf), &code, NV_TIMEOUT_MS) > 0 &&
		    code == 0)
			emit_sw_pairs(fd, buf);
	}
	/*
	 * The OTHER copy of the redundant environment: what U-Boot uses if the
	 * winning copy is ever left invalid, which an interrupted setenv is how
	 * it happens. A plain setenv writes only the winning copy, so a trial
	 * can leave the two disagreeing about sw_commit, and a page that says
	 * "the next reboot returns to slot N" needs both answers. odi-oss nv
	 * prints it for `nv fallback`; the stock nv prints its usage text, which
	 * carries no sw_ line, so this is empty there rather than wrong.
	 */
	put_fd(fd, "},\"fallback\":{");
	{
		static char *const fargv[] = { "nv", "fallback", 0 };
		long code = -1;
		long got = run_to_buf_ex("/bin/nv", fargv, buf, sizeof(buf), &code,
					 NV_TIMEOUT_MS);
		int known = nv_fallback_known(got, code, buf, sizeof(buf)) &&
			    (code != 0 || nv_fallback_dump_ok(buf, got));

		if (known && got > 0 && code == 0)
			emit_sw_pairs(fd, buf);
		/* No knowing what that copy says (no answer in time, a copy
		 * odi-oss nv could not read in full, a dump that filled the
		 * buffer or is not one, any answer that is not one of the
		 * known ones): the page then offers no write, as the write
		 * route refuses one. */
		put_fd(fd, "},\"fallback_unsure\":");
		put_fd(fd, known ? "false" : "true");
	}
	put_fd(fd, ",\"slots\":{");
	{
		char mtds[1024];

		if (read_file("/proc/mtd", mtds, sizeof(mtds)) <= 0)
			mtds[0] = 0;
		emit_slot(fd, mtds, '0');
		put_fd(fd, ",");
		emit_slot(fd, mtds, '1');
	}
	put_fd(fd, "},\"confd\":\"");
	put_json_cstr(fd, BUILD_ID);
	put_fd(fd, "\",\"exe\":\"");
	put_json_cstr(fd, confd_exe);
	put_fd(fd, "\"");

	/*
	 * A background write, if fwu_starter.sh started one: its state line
	 * split into fields, and the end of the flasher's output. The page
	 * polls this while the state says running.
	 */
	{
		char st[96];
		long n = read_file(FWU_STATE, st, sizeof(st));

		/*
		 * A state of running with nothing running any more: the writer may
		 * have finished between the read and the check, so read once more.
		 * If it still says running, no result was recorded (a --foreground
		 * write never does, a killed supervisor cannot): "unknown", not
		 * failed, and the page must not wait for it.
		 */
		int gone = 0;

		if (n > 0 && spre(st, "running ") && !fwu_running()) {
			n = read_file(FWU_STATE, st, sizeof(st));
			gone = n > 0 && spre(st, "running ");
		}
		if (n > 0) {
			unsigned long i = 0, f;
			static const char *field[] = { "state", "pid", "slot", "rc" };

			put_fd(fd, ",\"write\":{");
			for (f = 0; f < 4; f++) {
				unsigned long b;

				while (st[i] == ' ')
					i++;
				b = i;
				while (st[i] && st[i] != ' ' && st[i] != '\n')
					i++;
				if (f)
					put_fd(fd, ",");
				put_fd(fd, "\"");
				put_fd(fd, field[f]);
				put_fd(fd, "\":\"");
				if (!f && gone)
					put_fd(fd, "unknown");
				else
					put_json_str(fd, st + b, i - b);
				put_fd(fd, "\"");
			}
			put_fd(fd, ",\"log\":\"");
			n = read_file(FWU_LOG, filebuf, sizeof(filebuf));
			if (n > 0) {
				/* The tail: the last lines are the ones that say
				 * where it is and whether it failed. */
				unsigned long from = (unsigned long)n > FWU_LOG_TAIL
					? (unsigned long)n - FWU_LOG_TAIL : 0;

				put_json_str(fd, filebuf + from, (unsigned long)n - from);
			}
			put_fd(fd, "\"}");
		}
	}

	/* The switch files this UI may toggle, and the override that makes
	 * LAN_IP_ADDR a dead letter while it exists. */
	put_fd(fd, ",\"switches\":{\"" SWITCH_OMCI_IDENTITY "\":");
	put_fd(fd, file_exists(SWITCH_DIR SWITCH_OMCI_IDENTITY) ? "true" : "false");
	put_fd(fd, ",\"" SWITCH_CONFD_SETUP "\":");
	put_fd(fd, file_exists(SWITCH_DIR SWITCH_CONFD_SETUP) ? "true" : "false");
	put_fd(fd, ",\"" SWITCH_UPDATE_OFF "\":");
	put_fd(fd, file_exists(SWITCH_DIR SWITCH_UPDATE_OFF) ? "true" : "false");
	put_fd(fd, "},\"lanip_override\":");
	put_fd(fd, file_exists(LANIP_OVERRIDE) ? "true" : "false");
	emit_dev_files(fd);

	/* Which credential is in force. A built-in default nobody can see is the
	 * same thing as no password, so this is not decoration: it is what makes
	 * the fallback in confd.h defensible. */
	put_fd(fd, ",\"defaultauth\":");
	put_fd(fd, auth_is_default() ? "true" : "false");
	/* With the default in force the page shows the password form and
	 * nothing else, until a password is saved. On a safe-mode boot the
	 * default stays in force after the save, so the page needs this too
	 * (auth_saved() in http.c). */
	put_fd(fd, ",\"authsaved\":");
	put_fd(fd, auth_saved() ? "true" : "false");

	/* The build manifest, as an object. Emitted from the file rather than
	 * parsed into known fields: the build writes key=value lines, and a new
	 * component should appear here without a C change. */
	{
		char man[512];
		long n = read_file(BUILD_MANIFEST, man, sizeof(man));

		put_fd(fd, ",\"build\":{");
		if (n > 0)
			put_kv_members(fd, man);
		put_fd(fd, "}}");
	}
}

/*
 * Whether fwu_starter.sh has a write running. The pid in FWU_STATE is the
 * supervising shell, not the flasher: killing it leaves fwu.sh writing on. What
 * every process of a write shares is the writer lock (fd 9, inherited), so the
 * evidence is: the state says `running <pid>` and that pid is alive, OR the
 * lock is held. The same test the upload and the reboot refuse by, and the
 * status the page polls reports from it, so they cannot disagree.
 */
static int fwu_lock_held(void)
{
	long fd, r;

	/* Opened apart from any holder, so its flock conflicts with theirs; taken
	 * non-blocking and dropped at once. No lock file (an older image): no
	 * evidence either way, and the pid alone has to do. */
	fd = syscall3(__NR_open, (long)FWU_LOCK, O_RDONLY, 0);
	if (fd < 0)
		return 0;
	r = syscall3(__NR_flock, fd, LOCK_EX | LOCK_NB, 0);
	if (r == 0)
		syscall3(__NR_flock, fd, LOCK_UN, 0);
	syscall3(__NR_close, fd, 0, 0);
	return r == -EAGAIN_MIPS;
}

int fwu_running(void)
{
	char st[64];
	unsigned long i = 0, pid = 0;

	if (read_file(FWU_STATE, st, sizeof(st)) > 0 && spre(st, "running ")) {
		for (i = 8; st[i] >= '0' && st[i] <= '9' && i < 8 + 9; i++)
			pid = pid * 10 + (unsigned long)(st[i] - '0');
		/* Signal 0 only tests that the process exists. EPERM would also
		 * mean it does; confd runs as root, so only ESRCH (gone) says no. */
		if (pid && syscall3(__NR_kill, (long)pid, 0, 0) == 0)
			return 1;
	}
	return fwu_lock_held();
}

int nv_set(const char *key, const char *value)
{
	char *argv[5];
	char buf[256];
	long code = -1;

	argv[0] = "nv";
	argv[1] = "setenv";
	argv[2] = (char *)key;
	argv[3] = (char *)value;
	argv[4] = 0;

	/*
	 * The exit code is the whole check here, and this used to test the byte
	 * count instead: `nv setenv` prints nothing on success, and a child that
	 * failed to exec exits 127 printing nothing too. So a missing /bin/nv
	 * answered {"ok":true,"note":"armed"} and the page said the partition
	 * was armed for one boot. sw_tryactive was never written, the reboot
	 * came up on the old image, and the natural conclusion was that the new
	 * image had failed its trial.
	 */
	if (run_to_buf_ex("/bin/nv", argv, buf, sizeof(buf), &code, NV_SET_TIMEOUT_MS) < 0)
		return 0;
	return code == 0;
}

int nv_commit(const char *slot, char *msg, unsigned long cap)
{
	char *argv[4];
	char buf[256];
	long code = -1;
	long got;
	unsigned long i, k = 0;

	argv[0] = "nv";
	argv[1] = "commit";
	argv[2] = (char *)slot;
	argv[3] = 0;

	msg[0] = 0;
	got = run_to_buf_ex("/bin/nv", argv, buf, sizeof(buf), &code, NV_COMMIT_TIMEOUT_MS);
	if (got == -2) {
		str_copy(msg, "nv commit timed out", cap);
		return 0;
	}
	if (got < 0) {
		str_copy(msg, "could not run nv", cap);
		return 0;
	}
	/*
	 * Our nv answers a commit with "nv: commit <slot>: <what happened>" on
	 * every outcome, so that line is what tells a refusal from a nv that
	 * does not know the verb: the stock one prints its usage text and exits
	 * non-zero, which would otherwise read as a refusal on a stick that
	 * cannot do better. Exit 0 alone is success either way.
	 */
	if (code == 0)
		return 1;
	if (!spre(buf, "nv: commit ")) {
		/*
		 * Only the usage text means "no commit verb". Any other
		 * failure (a crash, a bad environment, an empty answer) is a
		 * failed commit, not licence for the caller to write one copy.
		 * The exact stock wording is known only to start with Usage.
		 */
		if (spre(buf, "Usage")) {
			str_copy(msg, "this nv has no commit verb", cap);
			return -1;
		}
		str_copy(msg, "nv commit failed", cap);
		return 0;
	}
	/* The first line, with the "nv: " prefix dropped: it names the reason. */
	for (i = 4; buf[i] && buf[i] != '\n' && k + 1 < cap; i++)
		msg[k++] = buf[i];
	msg[k] = 0;
	return 0;
}

int slot_state_refresh(void)
{
	static char *const argv[] = { "slot-state.sh", 0 };
	char buf[256];
	long code = -1;

	if (run_to_buf_ex(SLOT_STATE_SCRIPT, (char *const *)argv, buf, sizeof(buf), &code,
			  SLOT_STATE_TIMEOUT_MS) < 0)
		return 0;
	return code == 0;
}

/*
 * One U-Boot variable, from `nv <verb> <key>`: getenv for the copy U-Boot
 * uses, fallback for the other one.
 *
 * Only a line that ends in a newline is taken, and a value that does not fit
 * `out` is not taken at all: a value cut after its first digit is not one to
 * decide on. `known`, for fallback, says whether the answer is one to go by
 * (nv_fallback_known); a cut value is not, nor an exit 0 that printed
 * something other than the key: odi-oss nv prints the line of the key, or
 * nothing when the copy does not set it.
 */
static int nv_read(const char *verb, const char *key, char *out, unsigned long cap,
		   int *known)
{
	char *argv[4];
	char buf[1024];
	unsigned long i = 0;
	long code = -1, got;

	argv[0] = "nv";
	argv[1] = (char *)verb;
	argv[2] = (char *)key;
	argv[3] = 0;
	out[0] = 0;
	got = run_to_buf_ex("/bin/nv", argv, buf, sizeof(buf), &code,
			    NV_TIMEOUT_MS);
	if (known)
		*known = nv_fallback_known(got, code, buf, sizeof(buf));
	/* And only from an nv that exited 0: a complete line from one that
	 * then failed is not a value to decide on. For fallback the answer is
	 * the line of the key alone or nothing: a NUL, more lines, or the line
	 * after others is no knowing. */
	if (got <= 0 || code != 0)
		return 0;
	if (known && (unsigned long)got != str_len(buf)) {
		*known = 0;
		return 0;
	}

	while (buf[i]) {
		unsigned long ls = i, le = i, eq, k = 0;

		while (buf[le] && buf[le] != '\n')
			le++;
		eq = ls;
		while (eq < le && buf[eq] != '=')
			eq++;
		if (eq < le && spre(buf + ls, key) && (ls + str_len(key)) == eq) {
			if (buf[le] != '\n' || le - eq > cap ||
			    (known && (ls != 0 || buf[le + 1]))) {
				out[0] = 0;
				if (known)
					*known = 0;
				return 0;
			}
			for (k = 0; eq + 1 + k < le; k++)
				out[k] = buf[eq + 1 + k];
			out[k] = 0;
			return 1;
		}
		i = (buf[le] == '\n') ? le + 1 : le;
	}
	if (known && buf[0])
		*known = 0;
	return 0;
}

/*
 * Read one U-Boot variable.
 *
 * /api/firmware already emits every sw_* for the page, but a route that has to
 * DECIDE on one needs it in C -- and asking the page to send back what it was
 * told would let a caller choose its own answer. `nv getenv <key>`, not the
 * whole environment: a dump longer than the buffer was cut.
 */
int nv_get(const char *key, char *out, unsigned long cap)
{
	return nv_read("getenv", key, out, cap, 0);
}

/*
 * The same variable in the OTHER copy of the redundant environment, the one
 * U-Boot boots by if the winning copy is ever left invalid. Only the odi-oss
 * nv has the verb; one without it prints its usage and exits 1, and an
 * odi-oss nv with no valid second copy says so and exits 1. Both answer 0
 * here: by this answer there is no second copy to go by. -1 for any other
 * answer, which is no knowing: nv did not answer in time, was killed, said
 * that a copy could not be read in full (exit 3), exited 0 with something
 * other than the key, or failed in a way it has no known words for
 * (nv_fallback_known).
 */
int nv_fallback_get(const char *key, char *out, unsigned long cap)
{
	int known, r = nv_read("fallback", key, out, cap, &known);

	return known ? r : -1;
}
