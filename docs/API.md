# API reference

Quick reference for `confd`'s HTTP API. Every write route also validates and
authenticates as described in [`DESIGN.md`](DESIGN.md#authentication) — this
page is the wire contract, not the rationale. See `DESIGN.md` for why each
route behaves the way it does.

Every request, before the credential is looked at, must carry a `Host` that is an
IP literal, a single label or a private suffix (`.local`, `.lan`, `.home.arpa`,
`.localdomain`, `.internal`, `.localhost`, `.home`), or a name listed in
`/etc/config/confd.hosts`; anything else is `403` (DNS rebinding). A request a
browser marks `Sec-Fetch-Site: cross-site` or `same-site` is `403` unless it is a
top-level navigation. (Browsers send `Sec-Fetch-*` only to HTTPS and
`localhost`, so over plain HTTP to the stick this rule rarely applies.)

Every route but the sign-in ones (below) needs a credential: the session cookie
a browser gets from `/api/login`, or an HTTP Basic header, which is what `curl`
and scripts send. Send Basic up front (`curl -u`, `wget --auth-no-challenge`):
the `WWW-Authenticate` challenge is sent only in answer to a Basic header that
was wrong, never to a request with no credential, so that a browser never opens
its own password dialog. Without a credential, a `GET` that accepts
`text/html` (a browser opening a page) is `303` to `/login`, anything else is
`401`. A wrong credential costs one second.

All writes refuse a cross-site `Origin`, and (for `/api/config`) read every
value back before reporting success.

## Sign in

    GET  /login                          the sign-in page (and /login.js, /style.css),
                                          no credential needed; `303` to `/` when the
                                          browser already has a live session
    POST /api/login    user=...&password=...
                                          200 `{"ok":true}` with
                                          `Set-Cookie: odi_session=<32 hex>; Path=/; HttpOnly; SameSite=Strict`;
                                          401 `{"ok":false,"error":"wrong username or password"}`
                                          after one second; 403 from another site
                                          (a foreign or `null` Origin); 500 when no
                                          random bytes could be read
    POST /api/logout                     ends the session the cookie names, clears the
                                          cookie, `303` to `/login?out=1`; any method,
                                          any Origin, no credential needed. A request
                                          with a Basic header and no session gets the
                                          old answer instead: 401 with a fresh
                                          challenge and a "Signed out" page

A session is held in RAM, 8 at most (a ninth sign-in drops the least recently
used), and ends after 30 minutes without a request, after 24 hours in all, when
confd restarts, or at sign-out. A password change through `/api/password` ends
every session but the one that made it.

## Config and values

    GET  /api/static                     what the page reads at start that changes only
                                          with the image, in one answer:
                                          {"schema","meta","consumers","settings",
                                          "features","baseline": rows as their own
                                          routes answer them, "defaults": object}.
                                          `ETag`, `Cache-Control: private, no-cache`;
                                          304 with no body to a matching `If-None-Match`.
                                          500 when keys.tsv is missing, like /api/schema
    GET  /api/init                       what the page reads at start that the device
                                          holds: {"values","firmware","hostlink"}, each
                                          as /api/values, /api/firmware and /api/hostlink
                                          answer it; `no-store`; 500 when the config store
                                          cannot be read, like /api/values
    GET  /api/settings                  settings.tsv as JSON, [] when absent
    GET  /api/values                     current values, as the daemon's own parser sees them
    POST /api/config   key=value&key2=value2
                                          per-key result, apply class, and whether
                                          that class is a traced fact or an assumption;
                                          identity keys need `_confirm=identity`.
                                          On odi-oss also `needs` (the actions),
                                          `stock` and `interrupts` (whether the
                                          omci action drops the fibre service)
    POST /api/apply     what=network|omci|syslog|ntp|igmp|sfp
                                          apply.sh on odi-oss (`omci` signals the
                                          running omcid to reload: a VLAN change is
                                          rebuilt in place, an identity change
                                          re-registers the ONU); without it, `omci`
                                          restarts omci_app
    POST /api/switch    name=...&on=0|1  create or remove one allowlisted switch file:
                                          `omci-identity.on`; `confd.setup`, the setup
                                          wizard marker below; and `update-check.off`
                                          (present means the page does not look for
                                          new odi-oss releases, for every browser; the
                                          look itself is made by the browser, the stick
                                          contacts nothing). `/api/firmware` reports
                                          all three under `switches`

The page's data files, each a TSV from `/etc/confd/` (or its override in
`/etc/config/confd/`) served as a JSON array of objects, one per row:

    GET  /api/schema                     keys.tsv: name, store, address, section,
                                          type, apply, writable, common;
                                          500 {"error":"no schema"} when absent
    GET  /api/meta                       meta.tsv: name, label, help, options,
                                          depends, range; [] when absent
    GET  /api/consumers                  consumers.tsv: name, apply, readers
                                          (which programs read each key); [] when absent
    GET  /api/features                   features.tsv: mask, bit, feature, module
                                          (the OMCI_CUSTOM_* bits decoded); [] when absent
    GET  /api/baseline                   baseline.tsv: name, value; [] when absent
    GET  /api/defaults                   the image defaults, from /etc/config_default.xml
                                          and /etc/config_default_hs.xml, in the
                                          /api/values shape; {} when neither exists

Refused regardless of schema: `LAN_SDS_MODE`, `LAN_SPEED_MODE`, `FIBER_MODE`.

## MIB and services

    GET  /api/omci      cmd=...          `omcicli mib get` passthrough; refuses
                                          `get tables` outright (see DESIGN.md).
                                          Also refuses (403) classes 148, 157,
                                          307 and 65530, their names and `all`: they hold
                                          secrets the OLT provisioned.
                                          `me` is a class id (1-65535) or a table
                                          name (letters, digits, `_`, 39 at most);
                                          `entity` is optional hex, 1-4 digits (16
                                          bits), `0x` allowed
                                          `cmd=state`: `omcicli state` (ONU state,
                                          MIB data sync, dropped frames and, from
                                          an omcid with it, the `mib resets` line:
                                          OLT and local resets, OLT resets in the
                                          window, whether that is a loop). odi-oss
                                          only: 400 without /proc/odi_gpon/status,
                                          nothing run. The Status tab's link check
                                          reads it at most once a minute in O5

    GET  /api/voip                       the phone lines the OLT provisioned:
                                          {"raw": `omcicli voip`, "truncated", "ok"},
                                          or {"ok":false,"error"} with the raw text
                                          (no omcicli, timeout, refused). The masked
                                          view only: number, display name and login
                                          are shortened (`MASKED-` and the last four
                                          characters), the password is only said to be
                                          set. The argv is fixed, so no field can add
                                          `--secrets`
    POST /api/voip/secrets  password=... the same view with the number, name, login and
                                          password in clear, for a caller that repeats
                                          the admin password in the body. 403 on a wrong
                                          password (after a one-second delay) and while
                                          the built-in admin:admin is in force, 400
                                          without a password, 503 `{"ok":false}` and no
                                          output when the image has no omcicli.
                                          Nothing is logged and confd wipes the
                                          password and the output after answering
    POST /api/voip/status  port=1&state=registered
                                          the router tells the stick what its SIP
                                          client is doing, for the VoIP line status the
                                          OLT reads (odi-oss `OMCI_VOIP_LINE_REPORT=1`,
                                          off by default; without it the report is kept
                                          and shown but the OLT is told nothing).
                                          `port` is 1 or 2; `state` is one of `none`,
                                          `registered`, `in_session`, `failed_icmp`,
                                          `failed_tcp`, `failed_auth`, `failed_timeout`,
                                          `failed_server` (registration failures),
                                          `failed_invite_icmp`, `failed_invite_tcp`,
                                          `failed_invite_auth`, `failed_invite_timeout`,
                                          `failed_invite_server` (invite failures);
                                          G.988 9.9.11 voice server status 0 to 12. Nothing else is read: no number,
                                          login or password belongs in the body, and
                                          none is stored or logged. 200 `{"ok":true}`,
                                          400 for a bad port or state, 403 while the
                                          built-in admin:admin is in force or from
                                          another site, 401 without a credential. The
                                          report is kept in RAM with the stick's uptime
                                          and counts for 300 s: repeat it at least every
                                          few minutes (every 60 s is plenty), or the
                                          line status goes back to "config done". A
                                          router script can use
                                          `curl -s -u admin:PASSWORD --data
                                          'port=1&state=registered'
                                          http://STICK/api/voip/status`
    GET  /api/voip/status                what is held: {"ok":true,"ttl":300,"ports":
                                          [{"port":1,"state":"registered","age":12}]},
                                          `age` in seconds; a port with no report is
                                          absent

## Status and diagnostics

    GET  /api/status                     {"raw": one diag run (rx/tx power,
                                          temperature, voltage, bias current, ONU
                                          state, alarms, port counters)}; the page
                                          splits it on the prompt.
                                          {"error":"diag failed"} on failure.
                                          `chip_temp` rides along when the kernel has the
                                          hwmon device `rtl9602c_soc` (found by name in
                                          /sys/class/hwmon/hwmon0..7, file reads only):
                                          {"celsius":71.3,"max":95.0,"crit":110.0,
                                          "max_alarm":false,"crit_alarm":false}, degrees C
                                          with one decimal; a member is there only if its
                                          file is (temp1_input, temp1_max, temp1_crit,
                                          temp1_max_alarm, temp1_crit_alarm; older images
                                          have no limits or alarms); absent entirely
                                          without the device or temp1_input (stock image).
                                          For the stick diagram, one line of a file each,
                                          as a string after the prefix that finds it, and
                                          absent when the file or line is: `cpu` (/proc/stat
                                          "cpu "), `mem_total` and `mem_avail` (/proc/meminfo
                                          "MemTotal:", "MemAvailable:"), `onu_id`
                                          (/proc/odi_gpon/status "onu_id ", odi-oss;
                                          -1 for none), `alloc_ids` ("alloc_ids ",
                                          odi-oss: the count, then each Alloc-ID the
                                          OLT assigned), `o7_hold` ("o7_hold ",
                                          odi-oss: "keep N held N"), `o3_o4`
                                          ("onu_transitions O3 O4 ", odi-oss: how
                                          often the ONU entered ranging since boot;
                                          absent until it first did),
                                          `pon_id` (/proc/odi_gpon/status "pon_id ", odi-oss:
                                          what the OLT says of itself, "odn_class N
                                          reach_extender N tol N id HEX ms N"; absent
                                          when the OLT sends no PON-ID),
                                          `ranging` (/proc/odi_gpon/status "ranging_time ",
                                          odi-oss: "eqd_bits N protection_path N ..." from
                                          the last Ranging_Time, or "none"),
                                          `host_link` (odi_switch host_link, "0" or "1") and
                                          `host_mode` (/var/run/host-serdes "running=").
                                          `uptime`: the whole seconds of /proc/uptime
                                          For the shared PON section, from one read of
                                          /proc/odi_gpon/counters (odi-oss), so they belong
                                          to one driver sample: `ds_superframe`
                                          ("ctr_ds_superframe ") and `ds_gem_idle`
                                          ("ctr ds_gem_idle ", a 64-bit total), both or
                                          neither; with them `ds_fec` ("ctr_fec_now ds ")
                                          and `ds_gem_idle_sat` ("ctr_saturated ds_gem_idle ",
                                          there when a sample ever read the idle register
                                          full), each absent when its line is. A driver
                                          without ctr_ds_superframe sends none of them
    GET  /api/ntp                        {"now": the stick's clock, epoch seconds,
                                          "ntp": null, or {"event","time","offset",
                                          "stratum","last_sync"} from /tmp/ntp-status
                                          (odi-oss; known events only, values digits,
                                          `.` and `-`)}
    GET  /api/log                        kernel ring buffer, via klogctl
    POST /api/ping       host=<IPv4>      a literal a host can have (first number
                                          1-223, not 127, no leading zeros), no DNS
    GET  /api/l2                         `diag l2-table get entry address valid`
                                          (stock and odi-oss, different column sets)
    GET  /api/diag                       the diagnostics bundle, a tar.gz download:
                                          runs the image /etc/scripts/diag-bundle.sh
                                          (odi-oss; it collects and redacts) and
                                          streams what it wrote, up to 2 MiB.
                                          500 with {"ok":false,"error","output"}
                                          when the script fails or passes 60 s;
                                          501 on an image without the script

## Firmware

    POST /api/upload                     raw tarball as the body (not multipart);
                                          1 byte to 6 MiB, and it must start like a
                                          tar archive (`ustar` at offset 257), else
                                          400 and nothing is kept
    POST /api/firmware   action=write&partition=N
    GET  /api/firmware                    partitions, versions, build manifest,
                                          `defaultauth`, `switches`, write progress;
                                          `env` (the sw_* of `nv getenv`),
                                          `fallback` (the sw_* of `nv fallback`, the
                                          other environment copy; empty on stock nv),
                                          `slots` ({"0":{"kernel":..., "built":<unix>}},
                                          from each kernel partition's uImage header;
                                          {} when it cannot be read);
                                          `exe`, the path this confd was started from;
                                          `dev_confirm_arp`, only while
                                          `/etc/config/confirm-arp` exists: the IPv4
                                          address in it, or "" when it holds none
                                          (a name, a malformed or out-of-range
                                          address); `dev_breadcrumbs`, true only
                                          while `/etc/config/breadcrumbs.on` exists.
                                          Plain file reads; the UI never writes them
    POST /api/firmware   action=try|commit|reboot&partition=N
                                          reboot answers 409 while a write is running
                                          a refused commit answers
                                          {"ok":false,"error":"commit N: <nv reason>"},
                                          e.g. while confirm-arp exists; there is no
                                          force parameter
                                          a commit is accepted only for the running
                                          partition (`sw_active`, read by confd): any
                                          other, or an unreadable `sw_active`, answers
                                          400 {"ok":false,"error":...}; the one-copy
                                          setenv fallback needs that check too and runs
                                          only when nv prints its usage text

## Host port and safe mode (odi-oss)

    GET  /api/hostlink                    the state the image keeps, read with no fork:
                                          the host-port mode and trial
                                          (`/var/run/host-autoneg`), the link mode and
                                          trial (`serdes`: `supported` and `state`, from
                                          `/var/run/host-serdes`), the safe-mode
                                          flag for this boot and the record of an
                                          unacknowledged one, the host link;
                                          `supported` is false on an image without it
    POST /api/hostlink  action=try&mode=on|off
                        action=confirm | revert | ack
                        action=serdes-try&mode=fiber1g|2500basex|hisgmii
                        action=serdes-confirm | serdes-revert | serdes-status
                                          fixed verbs: try, confirm and revert run
                                          `host-autoneg.sh`, ack runs `safe-mode.sh ack`,
                                          the serdes-* ones run `host-serdes.sh try MODE`,
                                          `confirm`, `revert` and `status` (the mode is
                                          checked against the three names, nothing else
                                          reaches the script); bounded at 20 s. An image
                                          without the script answers
                                          `this image has no /etc/scripts/host-serdes.sh`.
                                          serdes-status also answers the script lines as
                                          `status` (`link`, `link_source`, ...): it forks
                                          (diag), so it is not part of the GET.
                                          `HOST_AUTONEG` and `HOST_SERDES` are never
                                          written by `/api/config`: only `confirm` stores
                                          them

## Management address trial (odi-oss)

`LAN_ROUTES`, the optional static routes of the management interface (up to 8
entries `DEST via GW`, joined by commas; `DEST` is `default` or a CIDR with its
host bits zero, `GW` an address inside the management subnet), is the sixth key
of the trial: `try` accepts it alone, or with the address keys, and an empty
value turns the routes off. It is held to a character set (digits, dots,
slashes, commas, spaces and the words `default` and `via`), then to the same
grammar and gateway check as a write to `/api/config`, and goes to the script
as one `KEY=VALUE` word with no shell. A gateway must be a host of a management
subnet: not the stick own address, not a network or broadcast address. The script
also refuses a trial that moves the addresses so that a stored gateway leaves the
subnets, unless the same trial sets or clears `LAN_ROUTES`; the page therefore
sends the stored routes with an address change. Where the firmware reports the trial in
`/api/netaddr`, `old_LAN_ROUTES` and `new_LAN_ROUTES` are in the state; a trial
that changes only these has no new address, and the page offers Keep on the page
it is on.

    GET  /api/netaddr                     the state the image keeps (`/var/run/mgmt-addr`,
                                          read with no fork: `phase`, `trial_deadline`,
                                          `prev_ip`, `old_<KEY>`/`new_<KEY>` for the five
                                          keys, the last `event`), `uptime`, and where this
                                          request came from: `via`, the address it was sent
                                          to, and `peer`, the client. `supported` is false
                                          on an image without `mgmt-addr.sh` and in a
                                          safe-mode boot, where the keys are stored directly
    POST /api/netaddr   action=try&LAN_IP_ADDR=...&LAN_SUBNET=...
                        action=confirm | revert
                                          one of three fixed verbs, run as `mgmt-addr.sh`
                                          and bounded at 30 s. `try` takes the keys it
                                          changes (`LAN_IP_ADDR`, `LAN_SUBNET`,
                                          `LAN_ENABLE_IP2`, `LAN_IP_ADDR2`, `LAN_SUBNET2`),
                                          each checked like a write to `/api/config` (type,
                                          the pair rules, the second address not equal to the
                                          first) and then by `network.sh` itself, and answers
                                          before the address moves; the stick applies it a
                                          second later, keeps the old primary up beside it
                                          and reverts after 90 s unless confirmed.
                                          `confirm` passes the script the address and the
                                          client of THIS connection, taken from the socket:
                                          it is refused unless the request arrived on a new
                                          address, which is the proof it works, and only then
                                          are the keys stored. While the script exists
                                          `/api/config` refuses these five keys (outside a
                                          safe-mode boot), so a trial value is never in the
                                          store before it was confirmed

There is no route for the redirect. The page on the old address looks for the
new one with a `no-cors` `fetch` of `/` (`credentials: omit`, a throwaway query),
which resolves for any HTTP answer and rejects when nothing answers, so it needs
no CORS grant and sends no credential. The stick answers that fetch with `403`
and the text `cross-site request refused` before it looks at any credential (and
so without the one-second delay a failed sign-in costs); nothing else leaves the
stick. Then it navigates to the new address, a top-level navigation, which is
allowed and answers `303` to the sign-in page there: the session cookie belongs
to the old address. There is no token to hand over (DESIGN.md, "Moving the
management address").

## Setup wizard marker

The setup wizard (`web/wizard.js`) keeps one fact on the stick: whether it was
completed or skipped. It is the switch file `/etc/config/confd.setup`, next to
`confd.auth`, owned by confd and read by nothing in the image, so every browser
agrees and no odi-oss key is involved.

    GET  /api/firmware                   `"switches":{"omci-identity.on":false,"confd.setup":false,"update-check.off":false}`
    POST /api/switch  name=confd.setup&on=1|0
                                          create or remove it; `{"ok":true,"on":true}`.
                                          400 for `on` other than 0 or 1 or a name not
                                          on the allowlist, 401 without the credential, 403 from
                                          another site, as for every write

Absent by default, so a stick nobody has set up shows the wizard when the fibre
has light and the ONU is not in O5; present, the page never opens it by itself
(the Setup button in the header always does). The page writes it on every way
out of the wizard and silently when it first sees O5. A factory reset removes
it with the rest of `/etc/config`.

## Backup and reset

    GET  /api/backup                      both config stores as a file, identity included
                                          500 when a dump (`flash all cs`, `flash all hs`)
                                          exits non-zero, prints nothing or does not fit
    POST /api/reset      _confirm=reset   `flash default cs` (service store only;
                                          `hs`, the hardware identity, is not reachable here)

The route always answers plain XML. The page encrypts it in the browser when
you give a password (nothing about the password reaches the stick), and the
result is an OpenSSL `enc` file (`Salted__`, 8 salt bytes, AES-256-CBC), with the
key and IV from PBKDF2-HMAC-SHA256 at a fixed 200000 rounds. Without this page or
the stick, decrypt it with:

    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
        -in odi-config-backup.xml.enc -out odi-config-backup.xml

(OpenSSL 1.1.1 or later; it asks for the password.) To encrypt by hand the same
way, drop `-d` and swap the files. The count is not stored in the file, so it is
part of the format; `web/crypto.js` holds it as `ITER`.

Restoring a backup has no dedicated endpoint: the browser replays it through
`/api/config`, key by key — see DESIGN.md. The management address keys of a
backup go through `/api/netaddr` instead when the image has the trial.

## Admin

    POST /api/password   user=...&password=...
                                          user 1-64 printable characters, no space or
                                          colon; password 4-128 printable ASCII. Ends
                                          every session but the one that made the change
    GET  /api/sshkeys                     {"path":..., "keys":[{"i":0,"line":"ssh-ed25519 AAAA... comment"}]}
    POST /api/sshkeys    key=<line>       append; the type is one of ssh-ed25519,
                                          ssh-rsa, ecdsa-sha2-nistp256/384/521 or an
                                          sk- type, the blob is whole base64 that
                                          parses to that same type, one printable
                                          line of at most 1000 characters; a key
                                          already in the file is refused
    POST /api/sshkeys    delete=<i>       rewrite the file without line i
                         [&line=<text>]   only while line i still reads <text>, as
                                          the list gave it; 409 when it does not

A missing `authorized_keys` is an empty list. One that cannot be read, or that
does not fit the daemon's 4 KB buffer (4094 bytes fit), answers 500 with
`{"ok":false,"error":...}` to all three, and nothing is written: edit it over
ssh. Send `line` with a delete: without it the number alone decides, and a
list that is out of date removes whatever key holds that line now.
