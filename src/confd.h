/*
 * confd — a web configuration UI for the ODI DFP-34X-2C2 (Realtek RTL9601D).
 *
 * Runs alongside the vendor's boa on its own port. It does not replace boa and
 * does not try to: boa's UI is 88 handlers compiled into the boa binary with no
 * CGI seam to hook, so the only way to extend it is to not use it.
 *
 * The design that makes this small: serve a static page and a JSON API, and let
 * the browser render. The device's configuration is ~184 MIB keys plus a couple
 * of indexed tables, described by a schema file rather than by C, so adding a
 * key is a data change and not a new handler.
 *
 * Values are emitted as the literal text `flash` printed. Nothing is parsed to
 * a number and formatted back, which is why a freestanding build with no libc
 * costs nothing here.
 *
 * This header carries what every translation unit needs: the paths it reads and
 * the two ports it binds. Everything else lives behind its own header.
 */

#ifndef CONFD_H
#define CONFD_H

#include "util.h"

/*
 * Stamped in by the Makefile from `git describe`. It is reported by
 * /api/firmware and shown in the page footer for the same reason the exporter
 * reports its own: /etc/config/confd/confd overrides the image's copy and
 * survives reflashing, so the binary that is running can quietly outlive the
 * image it was built against. Which one is live should be a query, not an
 * inspection.
 */
#ifndef BUILD_ID
#define BUILD_ID "unknown"
#endif

#define DEFAULT_PORT 8080
#define BACKLOG      8

/*
 * The longest value /api/config takes in one piece. OMCI_FIXED_ME is the one
 * key that needs more than a few hundred bytes: 16 entries of up to 66
 * characters and a separator each is 1071, and omcid reads the key into a
 * buffer of 16 x 80 = 1280 bytes. Every other type is bounded far below this
 * by its own rule.
 */
#define VALUE_MAX 1279

#define FLASH_PATH "/etc/scripts/flash"
#define DIAG_PATH  "/bin/diag"
#define OMCICLI_PATH "/bin/omcicli"
#define PING_PATH    "/bin/ping"
#define MD5SUM_PATH  "/bin/md5sum"
#define FWU_STARTER  "/etc/scripts/fwu_starter.sh"
/* Rewrites /var/run/odi-slot (what the exporter and the trial banner read)
 * from the environment; odi-oss only, absent on a stock-based image. */
#define SLOT_STATE_SCRIPT "/etc/scripts/slot-state.sh"
/*
 * What fwu_starter.sh leaves behind on an image that writes in the background
 * (odi-oss): the state, "running|ok|failed <pid> <slot> [rc]", and the flasher's
 * own output. /api/firmware reports both so the page can follow a write
 * without this daemon blocking for the eighty seconds it takes. Absent on an
 * image whose fwu_starter.sh still blocks, and then the POST answer is final.
 */
#define FWU_STATE    "/tmp/fwu.state"
#define FWU_LOG      "/tmp/fwu.log"
/* The writer lock fwu_starter.sh takes on fd 9 (flock -n) and every process it
 * starts inherits: held for as long as any of them lives. Beside the state file. */
#define FWU_LOCK     FWU_STATE ".lock"
/*
 * How the image applies saved settings without a reboot (odi-oss
 * /etc/scripts/apply.sh): `apply.sh network` re-applies the management
 * addresses, live; `apply.sh omci` restarts the OMCI daemon and re-ranges the
 * ONU, which interrupts the internet; `apply.sh syslog`, `apply.sh ntp` and
 * `apply.sh igmp` kill or restart the daemon so init respawns it with the stored setting. Absent, "omci"
 * falls back to restarting the stock omci_app, and the others are refused.
 */
#define APPLY_PATH   "/etc/scripts/apply.sh"

/*
 * The host-port auto-negotiation (odi-oss HOST_AUTONEG, host-autoneg.sh), and
 * the safe mode that can clear it (below). A
 * change is a trial the script applies in RAM and reverts by itself unless
 * confirmed, so the page never writes the key: it runs the script (try,
 * confirm, revert, ack). What the page shows is read from the files the
 * image keeps, with no fork: the state of this boot (key=value lines,
 * replaced by a rename), the safe-mode flag of this boot and its record on
 * the config partition (present until acknowledged), and the live host link
 * from the kernel.
 */
#define HOSTLINK_SCRIPT   "/etc/scripts/host-autoneg.sh"
#define HOSTLINK_STATE    "/var/run/host-autoneg"
#define HOSTLINK_SAFEMODE "/etc/config/safe-mode"
#define HOSTLINK_LINK     "/sys/module/odi_switch/parameters/host_link"
/*
 * The host-port SerDes mode (odi-oss HOST_SERDES, host-serdes.sh): the same
 * kind of trial, so the same verbs and the same reading, from its own state
 * file. `status` is the one verb that reads what the files do not hold (the
 * link and where it was read from, which in 2500basex needs diag), so it is a
 * fork the page asks for, never part of the GET.
 */
#define SERDES_SCRIPT     "/etc/scripts/host-serdes.sh"
#define SERDES_STATE      "/var/run/host-serdes"
#define HWMON_ROOT        "/sys/class/hwmon"
#define PROC_STAT         "/proc/stat"
#define PROC_MEMINFO      "/proc/meminfo"
#define GPON_STATUS       "/proc/odi_gpon/status"
#define GPON_COUNTERS     "/proc/odi_gpon/counters"
#define ODI_SW_DEV        "/dev/odi_sw"
#define UPTIME_FILE       "/proc/uptime"
/*
 * Why the previous boot ended, as the odi-oss kernel recorded it in the two
 * DRAM pages a watchdog reset keeps (odi_ramlog.c): the "previous boot:" line
 * ends in reason=<name>, or reason=power when DRAM lost its contents. Root
 * only, and absent on a stock slot.
 */
#define RAMLOG_PREV       "/proc/odi_ramlog_prev"
#define PREV_BOOT_MAX     200
#define NTP_STATUS_FILE   "/tmp/ntp-status"
/*
 * What the router says its SIP client is doing, per phone port, for omcid to
 * show the OLT (OMCI_VOIP_LINE_REPORT in odi-oss). One `LINE<port>=<state>
 * <seconds>` line a port, the seconds being the stick's uptime when the report
 * arrived: a clock that a missing RTC or an NTP step cannot move. On tmpfs, so
 * a reboot forgets it; omcid ignores a line older than VOIP_REPORT_TTL_S.
 */
#define VOIP_REPORT_PATH  "/var/run/voip-line-status"
#define VOIP_REPORT_TTL_S 300
#define VOIP_PORTS_MAX    2
/*
 * The odi-oss safe mode (safe-mode.sh): a recovery boot, entered by a run of
 * short power-ups, with the PON off, the host port on auto-negotiation and
 * the default credentials in memory, for that boot only. The flag of the
 * boot (tmpfs) is what confd reads: present, the web UI accepts
 * DEFAULT_AUTH whatever confd.auth holds (http.c). The record above
 * (HOSTLINK_SAFEMODE) outlives the boot until acknowledged with the script.
 */
#define SAFEMODE_FLAG     "/var/run/safe-mode"
#define SAFEMODE_SCRIPT   "/etc/scripts/safe-mode.sh"
/*
 * A config store the odi-oss image recreated at boot (config-reseed.sh): when
 * the config partition was erased, rcS installs a missing lastgood.xml or
 * lastgood_hs.xml from the defaults in the image, with the serial number and
 * the PLOAM password empty, so the PON stays down until they are set. The
 * record (key=value lines: files, build, uptime) stays on the config
 * partition until acknowledged with the script; the page reads it as it reads
 * the safe-mode record, with no fork.
 */
#define RESEED_RECORD     "/etc/config/config-reseeded"
#define RESEED_SCRIPT     "/etc/scripts/config-reseed.sh"

/*
 * The management addresses (odi-oss mgmt-addr.sh; LAN_ROUTES, the static
 * routes, rides the same trial). A change of LAN_IP_ADDR,
 * LAN_SUBNET, LAN_ENABLE_IP2, LAN_IP_ADDR2 or LAN_SUBNET2 is a trial the
 * script applies in RAM, keeps the old primary beside, and reverts by itself
 * unless confirmed over a new address, so a typo cannot take every way in with
 * it. While the script exists (and this is not a safe-mode boot, where the
 * rescue address is the way in and the keys are stored directly) POST
 * /api/config refuses the five keys: only the script's confirm writes them,
 * so a trial value is never in the store before it was seen to answer. The
 * script is told which address the confirm arrived on and who sent it, from
 * the socket; what the page shows is the state file the script keeps.
 */
#define NETADDR_SCRIPT    "/etc/scripts/mgmt-addr.sh"
#define NETADDR_STATE     "/var/run/mgmt-addr"
#define NETADDR_TIMEOUT_MS 30000  /* mgmt-addr.sh: up to 10 s for its lock, then
				   * flash reads and one network.sh run; the
				   * confirm writes up to five keys and reads
				   * each back. try returns at once */

/*
 * The diagnostics bundle (odi-oss /etc/scripts/diag-bundle.sh): the image
 * collects it, redacts every secret and writes one tar.gz; GET /api/diag only
 * runs the script and streams what it wrote. The collection lives in the
 * image because it is the image that knows its own logs, /proc files and
 * secret keys. DIAG_BUNDLE_MAX matches the script own BUNDLE_MAX: a larger
 * file is refused, not served in part.
 */
#define DIAG_BUNDLE_SCRIPT "/etc/scripts/diag-bundle.sh"
#define DIAG_BUNDLE_OUT    "/tmp/odi-diag.tar.gz"
#define DIAG_BUNDLE_MAX    (2u * 1024u * 1024u)

/*
 * Every child confd forks goes through syscall.h's drain_bounded(), which
 * SIGKILLs and reaps it past this many milliseconds of silence, instead of
 * leaving the parent parked in read()/waitpid() forever. confd is
 * single-threaded and serial: one wedged /bin/omcicli or /bin/diag would not
 * just fail its own route, it would freeze every other request behind it,
 * because the daemon never gets back to accept(). See AGENTS.md, "every wait
 * is bounded", and odi-sfp-exporter's syscall.h for the hardware incident
 * this mirrors (a respawn bug left omcid not answering its command queue,
 * and a blind read() on a child talking to it never returned).
 *
 * Each bound is sized to the slowest thing the command legitimately does, not
 * to the common case, so a merely slow command still finishes -- only one
 * that is actually stuck gets killed.
 */
#define OMCICLI_TIMEOUT_MS 2000   /* omcicli mib/dump reads (omci.c) */
#define DIAG_TIMEOUT_MS    3000   /* diag scrapes (status.c) */
#define FLASH_TIMEOUT_MS   5000   /* flash get/set/all/default (mib.c, routes.c) */
#define APPLY_TIMEOUT_MS  25000   /* apply.sh and the runomci.sh restart script:
				   * up to a 15 s poll loop plus a 3 s settle
				   * (mib.c apply_omci, routes.c /api/apply) */
#define PING_TIMEOUT_MS    6000   /* `ping -c 3`, ~1 s per probe plus slack */
#define HOSTLINK_TIMEOUT_MS 20000 /* host-autoneg.sh, host-serdes.sh: up to 10 s for its lock,
				   * then a flash set and its read-back, 5 s
				   * each at worst; try returns at once */
#define FWU_TIMEOUT_MS    20000   /* fwu_starter.sh backgrounds the flasher and
				   * returns in about a second, but may be silent
				   * for longer: two nv reads of up to 5 s each,
				   * then up to FWU_START_S (10 s) waiting for its
				   * job to start. Killing it in that wait reported
				   * a failure while the job went on to flash */
#define REBOOT_TIMEOUT_MS  3000   /* backgrounds the actual reboot and returns */
#define MD5SUM_TIMEOUT_MS  3000   /* hashing the uploaded image */
#define MKDIR_TIMEOUT_MS   2000   /* mkdir -p SSHKEYS_DIR */
#define NV_TIMEOUT_MS      2000   /* /bin/nv getenv/fallback (firmware.c) */
#define NV_SET_TIMEOUT_MS 12000   /* nv setenv: its lock waits up to 10 s, then
				   * one erase-and-write of an 8 KB environment
				   * partition. A kill in the erase leaves that
				   * copy invalid, so the budget is the writer's,
				   * not a reader's */
#define NV_COMMIT_TIMEOUT_MS 10000 /* nv commit: two erase-and-write cycles of an
				   * 8 KB environment partition, each read back */
#define SLOT_STATE_TIMEOUT_MS 12000 /* slot-state.sh: two nv reads, 10 s each at
				   * the very worst; milliseconds in practice */
#define DIAG_BUNDLE_TIMEOUT_MS 60000 /* diag-bundle.sh: about 20 steps of
				   * busybox timeout 5 s each plus a 10 s
				   * exporter scrape at worst; seconds in
				   * practice (status.c) */
/* The override network.sh prefers over LAN_IP_ADDR; reported so the page can
 * say the key is ignored while it exists. */
#define LANIP_OVERRIDE "/etc/config/lan-ip"
/*
 * Switch files on the config partition that the UI may create and remove.
 * An allowlist of exact names: the route that toggles them builds a path from
 * a request, and nothing but these names may reach the filesystem.
 *
 *   omci-identity.on   report the ONU identity keys (OMCI_SW_VER1/2,
 *                      GPON_ONU_MODEL, OMCC_VER, OMCI_VENDOR_PRODUCT_CODE) to
 *                      the OLT. Off, omcid answers what it always has.
 *   confd.setup        the setup wizard was completed or skipped (web/wizard.js).
 *                      confd's own marker, read by nothing in the image: it is
 *                      here so every browser agrees, and a factory reset removes
 *                      it with the rest of /etc/config.
 *   update-check.off   stop the page looking for new odi-oss releases. The
 *                      check runs in the browser, never on the stick; the
 *                      file is only where "off" is kept, so it applies to
 *                      every browser. Absent (the default) means on.
 */
#define SWITCH_DIR   "/etc/config/"
#define SWITCH_OMCI_IDENTITY "omci-identity.on"
#define SWITCH_CONFD_SETUP   "confd.setup"
#define SWITCH_UPDATE_OFF    "update-check.off"

/*
 * Two development files odi-oss reads at boot, reported to the Firmware tab
 * and never written by this UI. confirm-arp holds the IPv4 address the boot
 * must get an ARP reply from before it confirms the watchdog; breadcrumbs.on
 * turns on temporary debug logging. Both are overridable at build time so a
 * test can point them elsewhere.
 */
#ifndef CONFIRM_ARP_PATH
#define CONFIRM_ARP_PATH  "/etc/config/confirm-arp"
#endif
#ifndef BREADCRUMBS_PATH
#define BREADCRUMBS_PATH  "/etc/config/breadcrumbs.on"
#endif

/*
 * Where an uploaded image lands. /tmp is ramfs sharing ~27 MB with everything
 * else running, and about 12.9 MB of that is actually free -- so a 3 MB image
 * fits with room, and something much larger would not. UPLOAD_MAX is the guard:
 * it refuses before writing rather than after filling the filesystem every
 * other process on this device is also using.
 *
 * Not 8 MiB: /tmp is /var/tmp, a tmpfs the image caps at size=8m (odi-oss
 * rootfs/skeleton/etc/fstab), so an upload of exactly the old limit filled it
 * and left nothing for the flasher's own files (/tmp/fwu.d, fwu.log,
 * fwu.state) or for `flash set`, which stages its temp file there. A real
 * image is at most kernel plus rootfs partition, 3,997,696 bytes, plus the tar
 * headers, fwu.sh and md5.txt: well under this.
 */
/*
 * Wall-clock budgets, from the moment the request starts to be read. SO_RCVTIMEO
 * (main.c) bounds one read(), so a client sending a byte every 14 s never
 * tripped it and held the whole single-threaded daemon for as long as it
 * liked: these bound the sum. A browser sends a request in one go, so ten
 * seconds is generous for the headers and any body that fits the buffer; the
 * upload streams megabytes over whatever the link is and gets two minutes.
 */
#define REQUEST_DEADLINE_MS 10000
#define UPLOAD_DEADLINE_MS  120000
/* Where /api/upload puts the image: a name only this daemon creates (unlink,
 * then O_EXCL), so a copy to the ssh path below, even one still running, never
 * touches the bytes a write hashes and hands to the starter. */
#define UPLOAD_PATH  "/tmp/img.upload.tar"
/* Where the ssh instructions on the Firmware page copy an image. An upload
 * removes it, as it always replaced it: /tmp is RAM, two images may not fit. */
#define SSH_IMG_PATH "/tmp/img.tar"
#define UPLOAD_MAX   (6u * 1024u * 1024u)

/* The image ships these; /etc/config wins so the UI can be iterated without a
 * reflash, exactly as the exporter binary can. */
#define WEB_DIR      "/etc/confd/"
#define WEB_DIR_OVR  "/etc/config/confd/"
#define SCHEMA_PATH     "/etc/confd/keys.tsv"
#define SCHEMA_PATH_OVR "/etc/config/confd/keys.tsv"
#define META_PATH       "/etc/confd/meta.tsv"
#define META_PATH_OVR   "/etc/config/confd/meta.tsv"
#define CONS_PATH       "/etc/confd/consumers.tsv"
#define CONS_PATH_OVR   "/etc/config/confd/consumers.tsv"
#define BASE_PATH       "/etc/confd/baseline.tsv"
#define BASE_PATH_OVR   "/etc/config/confd/baseline.tsv"
/*
 * What THIS image does with each key: its apply class (live, restart, reboot,
 * internet), the action that applies it (network, omci, reboot), the key it is
 * written together with, who reads it, and a note. Per image like the schema:
 * a key with no row here is one nothing on the image reads -- kept in the store
 * and in backups for the stock firmware in the other slot, and not offered for
 * editing. Absent altogether, every key is offered, as before this table.
 */
#define SETT_PATH       "/etc/confd/settings.tsv"
#define SETT_PATH_OVR   "/etc/config/confd/settings.tsv"
/* Which bit of each OMCI_CUSTOM_* mask loads which plugin, generated from the
 * image's own lib/features by scripts/gen-features.py. Per-image, like the
 * schema: a different base implements a different set. */
#define FEAT_PATH       "/etc/confd/features.tsv"
#define FEAT_PATH_OVR   "/etc/config/confd/features.tsv"

/*
 * Two reference points for "is this value ours or the device's?".
 *
 * /etc/config_default*.xml is what the IMAGE ships, and is authoritative — but
 * it covers only ten keys. The full set of built-in defaults lives inside the
 * MIB and there is no read-only way to dump it: `xmlconfig -def_mib -os` looks
 * like it should and simply prints the current configuration instead, which
 * would have made every key look like a default.
 *
 * So the second reference is a baseline captured from a stick you consider
 * correct, which answers the question that actually gets asked: what have we
 * changed since.
 */
#define DEFAULT_CS "/etc/config_default.xml"
#define DEFAULT_HS "/etc/config_default_hs.xml"
#define AUTH_PATH    "/etc/config/confd.auth"
/* Extra names the UI answers to, one per line (http.c, host_ok). */
#define HOSTS_PATH   "/etc/config/confd.hosts"
/* dropbear -D names this directory; the image starts it that way. */
#define SSHKEYS_DIR  "/etc/config/dropbear.d"
#define SSHKEYS_PATH SSHKEYS_DIR "/authorized_keys"
/*
 * What confd uses when /etc/config/confd.auth is missing or empty.
 *
 * The UI used to refuse every request in that state. That is the safer posture
 * in the abstract and the wrong one here: the config partition is exactly what
 * a factory reset erases, and an image flashed onto a stick that has never had
 * the file is not "secured", it is a config UI nobody can open -- on a device
 * whose only other management paths are telnet and a 2007 dropbear.
 *
 * So it falls back, to the same credential every other service on this stick
 * already uses: SUSER_NAME/SUSER_PASSWORD ship as admin/admin and that is the
 * ssh and telnet login too. The fallback is never silently better than what it
 * replaces, and it is never invisible -- /api/firmware reports which one is in
 * use and the page says so on every tab until a real credential is written.
 */
#define DEFAULT_AUTH "admin:admin"

/*
 * Browser sign-in sessions (http.c). A browser signs in once on /login and
 * then carries a random token in a cookie; scripts keep sending HTTP Basic.
 * The table is in RAM only, so a confd restart signs everybody out. A full
 * table drops its least recently used session. A session ends after
 * SESSION_IDLE_S without a request, and after SESSION_MAX_S whatever happens;
 * an open page polls every 15 s, so only the second ends a session in use.
 */
#define SESSION_SLOTS   8
#define SESSION_IDLE_S  1800
#define SESSION_MAX_S   86400
#define SESSION_COOKIE  "odi_session"
#define RANDOM_PATH     "/dev/urandom"

/* Written by the image build: image=, base=, confd=, exporter=, built=.
 * One file naming every component, so "what is on this stick" is a single read
 * rather than three build stamps that have to be correlated by hand. Absent on
 * a stick running an override, which is itself worth seeing. */
#define BUILD_MANIFEST "/etc/odi-build"

#endif /* CONFD_H */
