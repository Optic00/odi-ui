# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- Status: a link check under the registration ladder, stage by stage: light,
  registered, OMCI with the OLT, services set up, traffic. Each stage shows
  its evidence, and the first that fails gives one finding: no light; an OLT
  that never ranges the stick since it stalled (the serial); one that ranges
  it and drops it again (the PLOAM password), told apart by the driver's
  O3 to O4 count, which catches the attempts a 15 s poll misses; ranging
  that does not complete (O4); an O7 disable; a MIB reset loop; registered
  and never provisioned; provisioned without a GEM port; services and no
  byte on the fibre port. A
  stage the image cannot report (the stock firmware) shows as unknown. The
  setup wizard's live hint uses the same check. `web/linkcheck.js`, pure,
  with its cases in `make check`. Refs #97.
- API: `/api/omci?cmd=state` runs `omcicli state` on odi-oss (400 and nothing
  run without /proc/odi_gpon/status), and `/api/status` adds `alloc_ids`,
  `o7_hold` and `o3_o4` (the `onu_transitions O3 O4` count) from
  /proc/odi_gpon/status. The MIB reset counts need an omcid
  with the `mib resets` line (AndreZiviani/odi-oss#393).
- Status: the transceiver bias current under Transceiver ("Bias current 14.1 mA", from the same
  diag run as the other readings, `pon get transceiver bias-current`), and how long the stick has
  been up under Stick ("Uptime 3 d 4 h 12 min", to the minute). The Stick block now shows on an
  image without the chip sensor too, with the uptime alone. `/api/status` gains `uptime`, the
  whole seconds of /proc/uptime, a plain file read. Refs AndreZiviani/odi-oss#384.

## v1.16.0 (2026-11-12)

- Config: optional static routes for the management interface, under Network, so the stick
  can be reached from another subnet without NAT (`LAN_ROUTES`, an odi-only key; empty by
  default, the default route allowed). A list of rows, Destination (`default`, or a network
  like 10.0.0.0/8 with its host bits zero) and Gateway, up to 8, with the errors written under
  the table: the gateway has to be a host inside the management subnet (the first address, or the
  second while it is on, as being edited; not the stick own address, nor a network or
  broadcast address), a destination cannot be listed twice, and an address
  change that would leave a stored gateway unusable is refused until the routes change with it,
  and a Save that changes addresses sends the stored routes in the same trial, as the script asks.
  Saving goes through the same trial as the management address: applied at once, kept only
  on Keep within the time. When only the routes change the page stays where it is and Keep
  works from it. confd checks the value as the firmware does (digits, dots, slashes, commas,
  spaces and the words default and via, then the grammar and the gateways) and hands it to
  `mgmt-addr.sh try` as one argument, no shell. Pairs with the firmware change in
  AndreZiviani/odi-oss#367; refs AndreZiviani/odi-oss#367. The Keep dialog and its result
  message name what is being tried: the static routes, the management address, or both.
- Status: the path loss is a meter of its own between Receive and Transmit, drawn like them: the loss range of the fibre plant class the OLT names is the window (ITU-T G.984.2: A 5 to 20 dB, B 10 to 25, B+ 13 to 28, C 15 to 30, C+ 17 to 32), the dimension lines give what is left to each end, and only the upper end is drawn as near the edge, since too little loss is the receive meter's overload. Under it: "Estimate. OLT sends 3.4 dBm, class B+: 13 to 28 dB", since the receive reading may be a few dB off and the OLT's launch power too, and so may the loss. When the OLT names no class it stays a plain line under the receive meter.
- Status: under Registration, the equalisation delay the OLT set in its last Ranging_Time, as "EqD 283548 bit 227.9 µs". The OLT sets it to a reference delay of its own less the round trip it measured, and never sends that reference, so no distance is shown; the tooltip says so. The page keeps a settled figure and moves it only when a reading is 25 bits or more (about 2 m) away from it, so the bit or two a ranging after a reboot moves it neither shows nor clears a change, and small steps that add up are shown. After a move a second row gives the change as the fibre it equals ("−122 bit ≈ +10 m fibre", about 8.2 cm per bit, a smaller figure is more fibre) with the day this browser first saw it; the tooltip says it also moves when the OLT changes its reference or the stick its response time. All of it is kept in this browser only (localStorage). A Ranging_Time for the protection path is not shown and not kept. `/api/status` gains `ranging`, the `ranging_time` line of `/proc/odi_gpon/status` (odi-oss), a plain file read; the row is hidden on `ranging_time none` or without it. `make check` covers both.
- Status: on the stick diagram the fibre line carries the two rates of the fibre side, down above it and up below, and moves while the ONU is in service (not with `prefers-reduced-motion`). The same figures stay in the Switch part, so the line is hidden from screen readers as before. The Fibre part names both directions, light in and light out. The first figure of each part is larger than what says more about it, and the diagram is a little tighter. Nothing new is read from the stick.

## v1.15.0 (2026-11-11)

- Status: the optics meters draw the zones their verdict goes by. The middle of the window is green, the outer 16 % at each end ('Near the edge') yellow, with a short fade centred on the line between the two, and what lies outside the window is faintly red. The limits of the window keep their hard edges; needle, dimension lines and figures are as they were. A title on the zones says what the colours mean. No new thresholds: the share is the one the verdict already used.

- Access: `/api/sshkeys` no longer changes an `authorized_keys` it has not
  read whole. The handler read the file into a 4 KB buffer and kept what fit:
  the list was short, and removing a key wrote the file back without everything
  behind the cut. A read error counted as an empty file, so adding a key
  replaced the file with that one key. A file that does not fit (4094 bytes do)
  or cannot be read now answers 500 to the list, an add and a delete, and stays
  as it is; a missing file is still an empty list. The page only ever grew the
  file to the buffer, so this takes one written by hand over ssh. A delete can
  carry `line=<text>` beside the line number and is then refused with 409 when
  that line no longer reads so. The page sends it and reads the list again
  after a refusal: before, a list that was out of date (a second tab, a change
  over ssh) removed whatever key held that line number. `delete=<i>` alone
  works as before. The setup wizard says when the keys could not be listed
  rather than "No keys installed yet". Refs #88.

- Backup: `/api/backup` answers 500 when `flash all cs` or `flash all hs`
  exits non-zero or prints nothing. Before, the exit status was not read and
  an empty hs dump was accepted: a file with flash's error line in place of a
  store, or with no hs store (`GPON_SN`, `ELAN_MAC_ADDR`, `MAC_KEY`), was served
  as 200 under the header "Both stores". The page already stops on a failed
  backup, also the one a reset takes first. `/api/values` and `/api/init` are
  as before, so the page still opens on a stick whose hs dump fails. Refs #87.

- Config: *802.1X EAPOL without the service tag* (`VLAN_EAPOL_UNTAGGED`,
  experimental) is on the VLAN page after the service VLAN ID and priority.
  `1`, with the manual tag on ("stick tags"), lets EAPOL frames cross the
  stick untagged in both directions while everything else keeps the service
  tag, for an ISP that authenticates the line with 802.1X on untagged or
  VLAN 0 frames while the service is on a VLAN; the router can then use one
  untagged WAN interface. Off (unset or anything else) is the default. Shown
  as ignored unless VLAN config mode and manual VLAN mode are both 1. Saving
  applies it live through the `omci` action (`apply.sh omci`, no reboot).
  Not yet run against a line that uses EAP. Pairs with AndreZiviani/odi-oss#336;
  refs AndreZiviani/odi-oss#301.

- Config: once a "VLAN forward operation override" (`RTK_DEVINFO_SPECVER`) is
  stored, its row says that the OMCI tab and `omcicli mib get 84` keep showing
  the FwdOp the OLT set, and that `omcli vlan` or `pon/omcli_vlan.txt` in the
  diagnostics bundle (AndreZiviani/odi-oss#344) shows the override in force.
  The sentence was only in the help under Details, and the unchanged 0x10 read
  as "not applied" to users coming from the stock firmware, which writes the
  code over the attribute. Only the page changes. Refs AndreZiviani/odi-oss#301.

- Firmware: a reboot is refused while a firmware write is running. `POST
  /api/firmware action=reboot` answers 409 with a message the page shows, the
  same refusal `/api/upload` already gave; before, a reboot could cut a write
  half way through the erase. The Reboot button is off while the write state
  is running, also when the write was started from the page (held from the
  request on, released if it fails), and on again when it ends. "A write is
  running" is now one test for the reboot and upload refusals and for the
  status: the pid in the state file is alive, or the writer lock
  (`/tmp/fwu.state.lock`, which fwu.sh inherits) is held, so a killed
  supervisor does not hide a flasher still writing. A state left at `running`
  with neither is reported by `GET /api/firmware` as `unknown` (after reading
  the file once more, in case the result was just recorded): the writer is
  gone and no result was recorded, as after a `--foreground` write. The page
  says so, tells you to check the partition before trying or rebooting, and
  leaves Reboot on. The write follow loop no longer
  reads a failed status poll as "written": a failed poll is unknown, it keeps
  asking every 3 s, and after 40 failures in a row (two minutes) it says contact
  was lost and the result is unknown. The reboot action is the only route that reboots the stick, so no other
  needed the same check. Refs #79.

- Status: under the receive meter, the launch power the OLT reports in its PON-ID (AndreZiviani/odi-oss#322) and what the path loses between it and the stick, with the fibre plant class the OLT names: "The OLT sends 3.4 dBm, so the path loses about 19.9 dB (it names its fibre plant class B+)". With the reach extender flag the line says so and the path is the one from the extender. `/api/status` gains `pon_id` (odi-oss driver), a plain file read; the line is left out when the OLT sends no PON-ID or no power, or without a receive reading, and the identifier in the PON-ID is not shown. The receive reading may be a few dB off, and so may the loss.

- Firmware: a commit is accepted only for the partition the stick is running,
  on every path. `POST /api/firmware action=commit` read no `sw_active`, so a
  stale tab could name a slot that never booted and, on a stock `nv` without
  the commit verb, the one-copy `setenv` made it the permanent boot target.
  confd now reads `sw_active` itself and answers 400 for any other partition,
  or when it cannot be read. That one-copy fallback now runs only when `nv`
  prints its usage text, not on any failed commit. `make smoke` covers the
  other partition, the running one, an unreadable `sw_active` and both
  fallback outcomes. Refs #78.

- Status: the *Shared PON, all ONUs* section shows its figure the way the
  optics meters do, with the rate under it and a bar from an empty to a full
  PON. The bar is blue under 50 %, yellow from 50 % and red from 80 %, as a
  guide and not a limit. The page keeps no history; that stays the metrics
  exporter's job. Only the page changes, confd and the API are untouched.

- Config and the setup wizard: the serial number field also takes the 16 hex
  digits some ISPs print as a modem ID, the vendor id as the codes of its four
  characters, with or without spaces, colons, dots or hyphens. It is converted
  in the field to the four characters and eight hex digits the stick stores,
  so what is saved does not change and confd is untouched. Under the field on
  the Config tab the serial is shown in hex as well. 16 hex digits whose first
  four bytes are not characters the stick can store are refused, with a
  message that says so.

- Firmware: next to Commit (the Trial boot banner and the running partition),
  the page warns while `/etc/config/confirm-arp` exists: every boot of a
  committed slot then needs an ARP reply from the address in it, or the stick
  resets. A file with no valid address says it has no effect. A quieter note
  shows while `breadcrumbs.on` exists (temporary debug logging). `GET
  /api/firmware` (and `/api/init`) carry `dev_confirm_arp` (the address, `""`
  when the file holds none, absent without the file) and `dev_breadcrumbs`,
  both plain file reads. Commit stays available: when `nv commit` refuses, its
  reason is shown (the commit error text now holds up to 255 characters instead
  of 127), and the page has no force option; removing the file is the way.
  `PREVIEW_DEV=1 scripts/preview.sh` previews both. Checked in the page and in
  confd. Refs AndreZiviani/odi-oss#334.

- Status: a section of its own, *Shared PON, all ONUs*, shows an estimate of how full the downstream of the whole PON is, every ONU on the fibre together and not this stick's traffic, as a percentage and in Mbit/s. It is the share of the downstream frames between two refreshes that was not idle GEM frames. `/api/status` gains `ds_superframe`, `ds_fec`, `ds_gem_idle` and `ds_gem_idle_sat`, one read of `/proc/odi_gpon/counters`; the section needs the `ctr_ds_superframe` line of the odi-oss driver (AndreZiviani/odi-oss#320) and is left out without it, as on a stock slot. Frame headers and management traffic count as in use, so an empty PON reads a little above zero; FEC parity is taken out; dummy frames an OLT sends in place of idle ones would read as load; nothing is said about the upstream. An interval that cannot be trusted (FEC changed, a reboot, a re-lock, the idle register read full) shows no figure, and outside O5 the section shows a dash. `make check` covers the arithmetic. Refs AndreZiviani/odi-oss#319.

## v1.14.0 (2026-11-10)

- Config: the VLAN subtab has a "VLAN forward operation override" field
  (`RTK_DEVINFO_SPECVER`, the same setting and format as the stock firmware's
  VLAN Forward Operation page, which odi-oss omcid now reads too). It
  replaces the forward operation the OLT set on a VLAN filter, for lines
  whose filter drops the 802.1X EAP frames the router needs. Applied live,
  without re-ranging; empty removes it. Checked in the page and in confd.
  Refs AndreZiviani/odi-oss#301.

- Page start: two requests instead of nine. `GET /api/static` gathers the image files (schema, meta, consumers, settings, features, baseline, defaults) under one `ETag`, so it is usually a `304`; `GET /api/init` gathers what the device holds (values, firmware, host link), `no-store`. The page no longer reads `/api/firmware` and `/api/hostlink` a second time while it opens. The single routes stay, unchanged, for scripts. In confd the six file routes are one table (`tsv_routes`) shared with `/api/static`. docs/API.md lists both; `make smoke` checks that each member matches its single route, the `304`, and the credential.

- confd: answers are HTTP/1.1 (still one request per connection, `Connection: close`). The web assets and the image files behind `/api/schema`, `meta`, `consumers`, `settings`, `features`, `baseline` and `defaults` carry an `ETag` and `Cache-Control: private, no-cache`: the browser keeps them, asks again on every load, and an unchanged one costs a `304` with no body. The tag is a hash of the confd build and the file, so a new image or a changed file is fetched again. `/api/values`, `/api/status` and everything else the device holds stay `no-store`. The page no longer asks the browser for `no-store` on every read, so the server's headers decide. `make smoke` covers the tags, the 304 and the credential it still needs.

- confd: responses are sent in 4 KB writes instead of one `write()` per token, and one per character inside JSON strings. On the stick `/api/schema` (31 KB) went from 0.22 s to 0.02 s and `/api/meta` (30 KB) from 0.31 s to 0.02 s, and since confd answers one request at a time, the nine requests the page makes when it opens now finish in about 0.2 s instead of 1.5 s (with AndreZiviani/odi-oss#304 for `/api/values`). The response bodies are byte for byte the same. Output is flushed before every fork and sleep, so the reboot answer still leaves before the reboot, and a client that stops reading costs one send timeout instead of one per write.

- Status: a diagram of the stick on top of the tab, fibre, optics, SoC (CPU, memory, GPON, switch), host lane and router, each part with its live figure and a status dot; clicking a part goes to the section that explains it. Inspired by the "Under the hood" view a user shared in AndreZiviani/odi-oss#300. `/api/status` gains `cpu`, `mem_total`, `mem_avail`, `onu_id`, `host_link` and `host_mode`, plain file reads with no fork; on a stock slot the parts without a source show a dash. The preview stub now prints the counters unindented, as diag does, so the Forwarding rates show there. The page polls once more 3 s after it opens, so the rates (switch, Forwarding, CPU) show a figure then instead of 15 s later. `make check` covers the diagram. Refs AndreZiviani/odi-oss#300.

- Config, OMCI: *Honour an OLT lock of the Ethernet port* (`OMCI_UNI_LOCK`) is off by default, to match odi-oss: the OLT's lock is answered and the port stays up, since on this SFP that port is the only way in. The help says what turning it on costs (this page, ssh, syslog and metrics go when the OLT locks the port, after a warning in the log) and how to get back in (restart with the fibre unplugged and turn it off, or five short power cycles: the safe-mode boot turns the setting off). The safe-mode banner says so when that boot cleared it (`cleared=OMCI_UNI_LOCK`). `make check` covers the banner. Needs odi-oss with AndreZiviani/odi-oss#287 for the new default; an older image still honours the lock when the key is absent. Refs AndreZiviani/odi-oss#287.

## v1.13.0 (2026-11-02)

- Build: `src/status.c` now includes `http.h`; it called `respond()` without a declaration, which GCC only warned about. Implicit function declarations are now a build error (`-Werror=implicit-function-declaration`), so the next one fails the build instead of scrolling past. No change in behaviour.

- Config: the odi-oss key `SFP_HOST_DDM` (added in odi-oss v1.14.0) is now in the schema, so it can be seen and changed from Config, Network as *Diagnostics for the router (host-side SFP EEPROM)*: `1` (the default, also empty or absent) lets the router read the module identity and live diagnostics from the stick, `0` turns that off. It takes effect at once with the new apply action `sfp` (`apply.sh sfp`), run straight after the save like the address and VLAN keys, with no reboot. `POST /api/config` reports it in `needs`, `POST /api/apply` accepts `what=sfp`, and `make check` accepts the `live`/`sfp` class and action pair; this also fixes the ODI_KEYS cross-check with odi-oss v1.14.0, which failed with *SFP_HOST_DDM: is in ODI_KEYS but not in the schema*. docs/API.md lists the action. Refs AndreZiviani/odi-oss#236.

- System, Backup & reset: backups are encrypted with a password. *Download encrypted backup* asks for a password twice and saves `odi-config-<host>-<date>.xml.enc`; *Download without encryption* is a plain link beside it, since the `flash set` recovery steps use the plain file. The reset block has the same optional password for the backup it downloads first (both fields empty gives a plain file, and the page says which it saved). Restore reads both: a file starting with `Salted__` asks for its password, and a wrong one, or a decrypted text that does not parse as a backup, gives *Wrong password, or the file is damaged* and writes nothing. The encryption runs in the browser, in the new `web/crypto.js` (SHA-256, HMAC, PBKDF2 and AES-256-CBC written out, 10.7 KB, because browsers hide `crypto.subtle` on a plain-HTTP page); confd and `/api/backup` are unchanged. The file is OpenSSL `enc` compatible with PBKDF2-HMAC-SHA256 at a fixed 200000 rounds (about 0.5 s in node), so it opens without the stick: `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -in odi-config-backup.xml.enc -out odi-config-backup.xml`. New `scripts/crypto-check.mjs` in `make check` runs the FIPS 180-4, RFC 4231, RFC 7914 and NIST SP 800-38A vectors and an openssl round trip in both directions (skipped when openssl is absent); `scripts/web-check.mjs` covers the restore decision. docs/API.md and docs/DESIGN.md describe it. Refs AndreZiviani/odi-oss#269.

## v1.12.0 (2026-10-31)

- System: a reboot is followed with a progress bar instead of *Rebooting. This page will stop responding.* After *Reboot* on System > Firmware, or *Reboot now* in the save bar, a dialog over the page shows the seconds gone and a bar measured against a real reboot (about a minute to the page answering again), says *Shutting down* and then *Starting up* from what the page sees of the stick, and reopens the same view when the stick answers, which is the sign-in page since the reboot ended the session. Past the usual time it says so; a stick that never went down, or does not answer after 5 minutes, gets an explanation and a *Reload* button, and after 15 minutes the page stops asking. *Reboot now* also reports a refused reboot now, where it used to say it was rebooting whatever the answer. No confd or API change. `make check` drives the phases, the bar and the dialog; docs/DESIGN.md describes it.

## v1.11.0 (2026-10-29)

- Release: a tag with a hyphen after the version (`v1.11.0-beta.1`) is published as a pre-release, never as the latest release, with the `## Unreleased` changelog section as its notes, so an odi-oss pre-release can pin a confd that is not released yet. Before, such a tag would have been published as the latest release with the fallback notes.

- A sign-in page replaces the browser's password dialog. Opening the stick goes to `/login` (username, password, *Sign in*), which posts once to the new `POST /api/login` and gets a session cookie (`odi_session`, 16 random bytes, `HttpOnly`, `SameSite=Strict`); the page then opens where it was headed. **Sign out** now ends the session for certain and lands on the sign-in page saying *You have been signed out*, instead of a 401 that Chromium answered with its own password dialog. Sessions live in RAM (8 at most, the least recently used dropped first) and end after 30 minutes without a request, after 24 hours, when confd restarts, or at sign-out; when one ends, the page goes to the sign-in page by itself and keeps the view. Changing the password keeps the browser that changed it signed in and signs every other one out, so the setup wizard no longer signs out when it closes. HTTP Basic is unchanged for `curl` and scripts, but the `WWW-Authenticate` challenge is now sent only after a wrong Basic header, never to a request with no credential: a client that waits for the challenge before sending Basic must send it up front (`wget --auth-no-challenge`). A request with no credential is answered at once (only a wrong password costs a second); a browser opening a page without one is sent to `/login` with `303`. `make check` drives the sign-in page and the page's reaction to an ended session; `make smoke` checks the sign-in, the cookie, sign-out, expiry by eviction, the password change and that Basic still works. docs/API.md and docs/DESIGN.md ("Sessions") describe both. Refs AndreZiviani/odi-oss#239.

- Sign out no longer answers *cross-site request refused* in Chromium browsers. The button posts a plain form, and because confd sends `Referrer-Policy: no-referrer` the browser sends that POST with `Origin: null`, which the cross-site check refused. `/api/logout` is now exempt from that check (every other write still refuses a foreign or `null` Origin); a foreign page signing you out costs a password prompt, nothing more. `make smoke` checks both. Refs AndreZiviani/odi-oss#239.

## v1.10.0 (2026-10-28)

- Header bars are now ordered by severity, in `index.html`: the red chip temperature bar first, then the yellow ones (trial boot, safe mode, host link and host mode fallback), then the blue release notice. Before, the chip bar would have sat under the trial boot bar. Each bar keeps its own logic; `make check` asserts the order.

- Status: the SoC chip temperature. `/api/status` gains `chip_temp` (`celsius`, `max`, `crit`, `max_alarm`, `crit_alarm`) read by confd from the kernel hwmon device `rtl9602c_soc`, found by name in `/sys/class/hwmon`, with plain file reads and no fork; a member is present only if its file is, and the whole object is absent on an image without the device. The Status page shows a *Chip temperature (SoC)* row in its own *Stick* block under Transceiver (the chip is the stick, not the optics module, and the transceiver alarms sit beside the optics rows); at the warning alarm the row is a warning (*above the warning limit (95 °C)*), and at the critical alarm a red bar in the header on every view, with a *Show on Status* button, says *The chip is very hot (112 °C, limit 110 °C). Check the airflow around the router's SFP cage.* The help says the sensor scale is not verified, the limits are set high on purpose and nothing is shut down automatically. The limits and alarms need the odi-oss kernel hwmon alarm change; without it the row shows the temperature alone. For `make smoke`, confd takes an optional second argument that moves the hwmon directory (the image starts it with the port alone). `make check` drives the row and the bar; `make smoke` checks the exact JSON for no device, no limits, normal, warning and critical. docs/API.md and docs/DESIGN.md describe both.

- Setup: a setup wizard, opened by a new **Setup** button in the header and by the page itself on a stick nobody has set up (no setup marker, light on the fibre, the ONU not in O5). It asks four things in simple mode: admin access (the admin password while the built-in one is in force, and an optional SSH key appended through `/api/sshkeys` with the same checks as System, Access, shown against the keys already installed; ssh has keys only, no password), the ISP login (serial, optional PLOAM password, and a *My ISP gave me a LOID* section), the VLAN as one question (*My router tags the VLAN* / *The stick tags it* with VLAN ID and priority / *Let the OLT decide*), then a review of the exact changes (old to new, secrets as dots, what each costs) before it writes through the Config save path, followed by a live view of the ONU going from O1 to O5 with the services and a plain hint when it stalls. Fields are pre-filled with what the stick holds and only changed keys are written; the PLOAM password takes the forms the image takes and is stored as the 20 hex digits. *Skip, I'll use Config* is on every step. The marker is the new switch file `/etc/config/confd.setup` (`POST /api/switch name=confd.setup&on=1`, reported under `switches` in `/api/firmware`), written by every way out of the wizard and silently by the first status that shows O5, so a stick configured before this version never shows it while it works, and removed by a factory reset. No odi-oss key or change. `make check` drives the rule, the validation, the VLAN mapping, the masking and every exit; `make smoke` checks the marker route and a wizard-shaped write. docs/API.md and docs/DESIGN.md describe both.

- Config, Network: a link mode control in the Host port block for the odi-only key `HOST_SERDES` (odi-oss: how the host port talks to the router; needs odi-oss #230). Choose Fiber 1G (1000BASE-X, the default and the most compatible), 2.5G (2500BASE-X, which runs with auto-negotiation off) or HiSGMII and press Try this mode: the image applies it a second later in RAM, the same Keep or Revert dialog counts the window down, and with no answer it goes back by itself after 120 s. A wrong mode makes the stick unreachable until then, and the help says so. The key is never stored by Save (`writable=never` in the schema); only Keep, which runs `host-serdes.sh confirm`, stores it. While the mode is not Fiber 1G the image refuses an auto-negotiation trial, so that control is disabled and its status row shows the bit the link mode set (for example "off (set by the 2.5G (2500BASE-X) link mode)"); after a boot fell back to Fiber 1G the control stays usable and says a change there lasts only until the next boot, which runs the stored link mode again. The status rows show the host link as the image reports it and where it was read from (the port link, the link sync, or no signal in HiSGMII), and a banner says when a boot in 2.5G found no link and runs Fiber 1G instead. The safe-mode banner reads the new comma-separated `cleared=` list (`HOST_AUTONEG`, `HOST_SERDES`, both, `none`, `failed`). `/api/hostlink` gains the `serdes` state in the GET and four fixed POST verbs (`serdes-try` with one of the three mode names, `serdes-confirm`, `serdes-revert`, `serdes-status`), bounded at 20 s; an image without `/etc/scripts/host-serdes.sh` answers a clear error and shows no control. Refs AndreZiviani/odi-oss#229.

- System: the page tells you when a newer odi-oss release exists. A bar in the header on every view ("odi-oss v1.13.0 is available") links to a dialog with the notes of every release newer than the one the stick runs, newest first, each with its tag, date and GitHub page, and points to the Firmware tab for flashing; nothing is downloaded or flashed by it. The check is made by the browser, never the stick: it asks api.github.com for the release list at most once a day per browser (answer kept in `localStorage`, failures silent), and only when the stick runs a release tag (`v1.12.0`, or a pre-release such as `v1.13.0-beta.1`; a local build is skipped). A pre-release is offered only to a stick that already runs one. Dismissal is remembered per version. It is on by default, and System > Firmware > New releases turns it off for every browser: the state is the file `/etc/config/update-check.off` on the stick (`POST /api/switch name=update-check.off`, reported under `switches` in `GET /api/firmware`). With it on, GitHub sees the address of the browser that opens the page, and the help says so. The release notes are rendered as text with a small safe subset (headings, lists, `code`, bold, https links); markup in them is never interpreted. When more newer releases exist than the dialog lists, or the fetched page may have cut older ones off, its last line links to the full releases list.

- Config: a stick whose config store is larger than about 24 KB no longer shows the identity keys as empty. A stick that ran a router firmware before keeps that firmware's WAN and port-binding tables in the store (one report: 30 KB in `lastgood.xml` alone), and confd read both stores into a 24 KB buffer: the odi-only keys and the whole hs store, `GPON_SN`, `GPON_ONU_MODEL` and `ELAN_MAC_ADDR` among them, were cut off without an error, and the configuration backup was missing them too. The buffer is now 64 KB, and a store that still does not fit is refused with a message (`/api/values` and `/api/backup` answer 500) instead of being served cut. A timeout reading the hs store is now an error too, where it used to serve the cs store alone. Refs AndreZiviani/odi-oss#229.

## v1.9.0 (2026-10-26)

- Config: `MLD_SNOOPING` (experimental) is on the Services page next to `IGMP_SNOOPING` and `IGMP_PON_DROP`: `1` makes the snooping daemon follow the host's MLD as it follows its IGMP, so IPv6 multicast groups get a row each; it does nothing while `IGMP_SNOOPING` is off. Saving restarts `igmpd` through the existing `igmp` action (`apply.sh igmp`, no reboot). Pairs with odi-oss #224.

- Phone: a router can now tell the stick whether its SIP client is registered or why not
  (`POST /api/voip/status`, `port=1&state=registered`, same credentials as the
  rest of the UI, refused while the factory password is in force). With
  `OMCI_VOIP_LINE_REPORT=1` in the image, the OLT then reads that state as the
  line status instead of "config done", for as long as the report is fresh
  (300 s). The Phone tab shows the last report and its age. Only the port and
  a state word are kept, in RAM; no number, login or password is accepted,
  stored or logged. Needs odi-oss with `OMCI_VOIP_LINE_REPORT`.

- OMCI, Phone: a new Phone view next to Services and MIB browser shows, per phone port, what the OLT provisioned for voice: line status, SIP user and login (masked), proxy, outbound proxy and registrar, port, DNS and expiry, codecs, DTMF, RTP ports and the voice VLAN, parsed from `omcicli voip`. It says plainly that the stick has no phone socket and registers nothing, so the router behind it registers the line with these values, and the status is the stick's own ("config done"), never "registered". While `OMCI_POTS_PORTS` is 0 it says phone ports are off and where to turn them on (Config, ONU identity, Expert settings). New `GET /api/voip` (masked view, fixed argv, the usual bounded wait and error shapes) and `POST /api/voip/secrets` (the clear view for a request that repeats the admin password; refused while the factory admin:admin is in force, wrong password costs a second, nothing logged, password and output wiped after use, 503 without omcicli). "Show secrets" asks for the password, keeps what comes back in memory only and drops it on Hide or when leaving the view. `make smoke` checks both routes against an `omcicli voip` stub (masked view, the stub password never in the GET, the secrets route refusing without or with a wrong password, with the factory password, cross-site and without omcicli). docs/API.md lists them. Pairs with odi-oss `omcicli voip`.

- Config: every odi-only key of the odi-oss image that the schema lacked is now on the page, each with the apply class from odi-oss `docs/SETTINGS.md`. Services: `IGMP_SNOOPING` and `IGMP_PON_DROP` (experimental; the drop of unjoined multicast from the fibre is its own opt-in and is ignored while snooping is off). Line: `GPON_KEEP_DISABLE`, `GPON_DYING_GASP` (experimental, read at boot) and `ODI_LASER_UNVERIFIED` (danger, at boot). ONU identity: `OMCI_UNI_LOCK` and `OMCI_TCONT_ALLOC_UNSET` (live, nothing to apply). Expert settings: `OMCI_POTS_PORTS` (experimental) and `OMCI_POTS_SLOT_ID` (2 to 254), which re-register the ONU and so interrupt internet; the slot has no `depends` because `meta.tsv` cannot say "1 or 2", and its help says it does nothing while phone ports are 0. Saving the IGMP keys restarts `igmpd` through a new `igmp` action (`POST /api/apply what=igmp`, `needs` entry `igmp`, `apply.sh igmp`). The settings and meta buffers in confd grow (`sett` 8 to 16 KiB, `meta` 24 to 32 KiB) because the tables no longer fit. `scripts/check-schema.py` now fails when a key in odi-oss `ODI_KEYS` (its `etc/scripts/flash`, from `ODI_OSS_FLASH` or a sibling `../odi-oss` checkout) has no schema or settings row, so the two cannot drift again; it is skipped, and says so, when that script is not at hand (the repos cannot be checked against each other in CI). Pairs with odi-oss #206 (`IGMP_PON_DROP`) and #211 (`OMCI_POTS_*`).

- MIB browser: `GET /api/omci?cmd=me` refuses classes 148 (authentication security method), 157 and 307 (large string, octet string) and 65530 (`LoIdAuth`, the line LOID and password), their table names (`AuthSecMethod`, `LargeString`, `LoIdAuth`) and `all` with 403, so a secret the OLT provisioned is never forwarded to the browser, even when `omcicli` prints it unmasked as it does on an image older than the omcid masking. confd builds the `omcicli` argv itself from the domain-checked class and entity only, so no query field can add `--secrets` or any other argument. `make smoke` checks both against a stub that prints the secret bytes. docs/API.md says so. The page shows the reason a request was refused next to the HTTP status (any route that answers `{"error": ...}`), not the status alone.

## v1.8.0 (2026-10-21)

- Management address: a change of `LAN_IP_ADDR`, `LAN_SUBNET`, `LAN_ENABLE_IP2`, `LAN_IP_ADDR2` or `LAN_SUBNET2` is a trial on an image that has odi-oss `mgmt-addr.sh`. Save and Restore no longer store these keys: the stick moves to the new address, keeps the old one working beside it, and goes back by itself after 90 seconds unless the change is kept on the new address, which is the proof that it works. A dialog counts the window down on every tab and on a page loaded mid-trial. A page on the old address opens the new one by itself: it probes the new address (a no-cors fetch, so no CORS change and no credential) until it answers, then navigates there, keeping the scheme and port, and the page that opens shows the countdown and Keep; the browser asks for the password again there (HTTP Basic is kept per address, and there is no session or token to hand over). If the new address never answers the page stays on the old one with the countdown and Revert, and says so; it redirects once per trial per tab; a netmask-only change opens nothing; a new second address is a target; a safe-mode save, stored directly, follows the same way. No new route. New `GET`/`POST /api/netaddr` (state with the address the request came in on; `try`, `confirm`, `revert`), where `confirm` hands the script the address and the client of that connection, from the socket. While the script exists `POST /api/config` refuses the five keys, so a trial value is never in the store before it was confirmed; a safe-mode boot, and an image without the script, keep the direct save. The save-time prompt, the schema help and `docs/API.md` say so. `make check`, `make smoke` (the route against a stub script, the socket addresses, the refusals) and `make verify` pass. Pairs with odi-oss `mgmt-addr.sh`.

## v1.7.1 (2026-10-21)

- docs/DESIGN.md: the "no TLS" paragraph says what is measured and what is not. The cost of a handshake on this core was an estimate of ours; another open implementation for the board measured about 0.1 s per handshake and about 22 KiB compressed. The decision (cleartext on the host link) is unchanged, and the paragraph no longer cites `boa` and telnet, which the odi-oss image does not have. AGENTS.md no longer lists `bltzl` as confirmed to work: it decodes but misexecutes on the core (its delay slot always runs), and nothing here uses it.

- Sign-in: the built-in admin:admin is used only when the credential file is missing or empty. A file that is there but cannot be read (a flash error, no file descriptor left) used to fall back to it too, putting the password everybody knows in force on a stick that has its own; now every sign-in is refused until the file reads again (safe mode still accepts the default).

- docs/API.md lists every route: `/api/ntp`, `/api/status`, `/api/schema`, `/api/meta`, `/api/consumers`, `/api/features`, `/api/baseline`, `/api/defaults` and `/api/logout` were missing. `make check` now fails when a route in `src/routes.c` is not in the docs, or the docs list one that does not exist.

## v1.7.0 (2026-10-18)

- OMCI, MIB browser: the Tables pane lists every managed entity class (82, from odi-oss's OMCI model) with its class id and official name, such as 268 "GEM port network CTP": G.988's own wording for every standard class, the stock firmware's for the vendor-specific ones (which G.988 leaves unnamed), with the vendor table name under it. It now includes the classes the stock firmware does not have, such as 46 "MAC bridge configuration data" and 65529 "ONU capability". The filter matches the class id, the official name or the table name, and every class is read by its id. The list is generated by `scripts/gen-mib-classes.py`.

- OMCI, MIB browser: three linked panes in place of the one-table picker. Tables (class id, name, entity count, with a filter by name or class id), the selected table's entities (hex and decimal id, attribute count), and the selected entity's attributes, parsed or raw (that entity's lines as printed). Read again, an opt-in Count entities that reads every table once through the same API call, and Look up for a class id, name or single entity that is not in the list. A phone shows one pane at a time. Still read-only, and still never asks the device for its table list. No daemon change: it is the same `/api/omci?cmd=me` read.

## v1.6.2 (2026-10-18)

- OMCI tab: a table name may be up to 39 characters, not 32, so MacBridgePortPmMonitorHistoryData (33) can be read.
- Config, NTP_SERVER: a line under the field shows the stick's clock (and how far it is from this browser's) and what the time service last did: when it last synced and by how much it corrected the clock, "No sync yet" or "Lost sync". It says so when the clock is more than a minute off, or when NTP is off. It refreshes every 10 seconds while the Services tab is open. The daemon answers it from a new `GET /api/ntp`, which reads the one small status file the image keeps and passes on only known fields.

## v1.6.1 (2026-10-17)

- Config: the help for OMCI_CUSTOM_ME names bit 64 (0x40), which creates the class 65529 entity, besides 0x100.

## v1.6.0 (2026-10-17)

- Config: field help moves behind a `?` beside each setting's name. Clicking it opens the one-line help, with "+ Details" under it as before; warnings about what is wrong now stay visible.
  A "Full help" button in the header (Config tab only, remembered across reloads) opens every field's help at once.
- Config, ONU identity: while the identity switch is off, each key carries a "Not reported" tag instead of repeating the same sentence on every row (the sentence is in its help), and the switch's explanation sits behind a `?`.
- Config: a setting's tags sit on the same line as its input, to the right, in a column of one width so the inputs line up, and on a desktop as tall as the input; the fixed entity answers table has its tags right after it, level with its first row. The cost badge there shows only its bars, since the legend above the rows names each one; screen readers get the full text from its `aria-label`, and on a phone or a touch screen without hover the words show beside the bars as before.
- Restore: the differences are a table headed Setting / On the stick / In the backup, with the stick's value muted, the backup's in the blue of a pending change, and identity keys tagged as on the Config tab.

## v1.5.1 (2026-10-17)

- The page uses the full window width: `main`, the banners, the error box and the save bar no longer stop at 1180px.
- Config: a setting's input or dropdown fills its column
- Status: the receive and transmit meters sit side by side when there is room for both (320 px each), and stack as before on a phone; the "class B+..." line under each is centred.
- Forwarding and Learned addresses share a row in two columns above 900 px, and a rule separates Raw diag output from them.
- Backup & reset tab: Backup and Restore share a row in two columns above 900 px.

## v1.5.0 (2026-10-17)

- Web: the page no longer judges an address or netmask twice (an older copy
  of the rule, left by a merge, ran before the current one and gave the older
  error messages).

- Firmware: Try refuses a partition whose kernel U-Boot would not boot. The
  daemon checks the uImage magic, header CRC and data CRC of the kernel
  partition (the same checks bootm makes, `src/uimage.h`, read in 64 KB steps
  with no child process) before it writes `sw_tryactive`, and the page shows
  a hint instead of the button for a partition with no uImage at all. An
  erased partition, or one whose flash was cut short, used to be armed like
  any other and ended at the bootloader prompt. Found in an audit of the
  update path; odi-oss writes the kernel last since then, so an interrupted
  flash always fails this check.
  `scripts/uimage-test.sh` checks the CRC code against python's zlib.

- Validation of every input, stacked on the config-key work above (night audit
  2026-10-16, "make sure the web UI validates all inputs"). The daemon first,
  then the page with the same rule, and one table of accepted and refused
  examples (`scripts/fixtures/validation-vectors.tsv`) that `make check` runs
  through the page and `make smoke` posts to the daemon, so neither can change
  a rule alone:
  - config keys: `int` is at most ten digits and 4294967295 (a 400-digit value
    was written, and omcid's 15-character buffer read it as absent);
    `string` is printable ASCII of at most 255 characters with no quote, `<`
    or `&` (a tab or carriage return was stored, and flash refused the other
    three with a bare "did not stick"); `ipv4` has no leading zeros (octal in
    busybox); `hostport` checks the labels (`a..b`, a 64-character label and
    `999.1.1.1` passed and made ntpd exit and respawn); `PON_VENDOR_ID` is at
    most four characters; `OMCI_VEIP_SLOT_ID` refuses 128, which omcid
    ignores; the second management address may not equal the first while it is
    on (network.sh refused to add it, silently); a `%00` in any form field is
    refused instead of ending the value there; and a full `OMCI_FIXED_ME` table
    (up to 1071 bytes, which the grammar and omcid accept) is no longer cut at
    511 bytes by the daemon.
  - the password form: the page checks the rules the daemon already had and
    asks for the password twice; a name or password too long for the daemon's
    buffer is told its limit instead of "required".
  - ssh keys: the type must be ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256/384/521
    or an sk- type, the blob must parse as length-prefixed fields that name that
    type and add up exactly (a truncated paste, a private key or a fingerprint
    no longer pass), a duplicate is refused, and removing a key asks first.
  - firmware upload: the page refuses an empty file, one over 6 MiB, or one that
    does not start like a tar archive before sending it, and the daemon checks
    the tar header too and keeps nothing else. `make check` compares the two size
    limits.
  - ping takes an address a host can have (1-223, not 127, no leading zeros);
    the MIB browser checks the class id (1-65535) and the entity (16 bits) in the
    page and in the daemon.
  - restore lists the values the daemon would refuse before writing anything,
    judges a backup as a whole (an address with its mask, as in the file), refuses
    a file over 1 MiB, and asks once more, naming the keys, before writing
    identity keys.

- Validation: a value is accepted when the code that reads the key accepts
  it (night audit 2026-10-16). New schema types, enforced by the daemon and
  checked by the page: `ipv4host` and `netmask` for the management address and
  its netmask (no 0/8, loopback, multicast or broadcast address; a netmask is
  ones then zeros, /8 to /30; no leading zeros, which `ifconfig` reads as
  octal), because `network.sh` re-reads them at every boot and one the kernel
  refuses left the stick unreachable. The address and the netmask are also
  judged together, as `network.sh` judges them: the network or broadcast
  address of the mask (192.168.1.0 and 192.168.1.255 on a /24) is refused, for
  the primary and the second address, against the netmask in the same request,
  else the stored one, else /24, and a netmask is refused when it makes the
  address one of the two; `gponsn` for `GPON_SN` (four characters
  and eight hex digits, as the kernel `gponsn` verb takes); `hex20` for
  `GPON_PLOAM_PASSWD` (exactly 10 bytes; the kernel reads a shorter value as
  literal text); `str14`/`str20`/`str24`/`str12` for the software versions, the
  model and the LOID keys, the width of the field the OLT reads (omcid answered
  a longer value as absent). `ELAN_MAC_ADDR`, with its own type `elanmac`, refuses a
  multicast or all-zero MAC (the other MAC-shaped keys, `HW_SERIAL_NO` and
  `WLAN_MAC_ADDR`, stay plain 12 hex digits). `scripts/gen-schema.py` keeps the types in `TYPE_OVERRIDE`.

- Config: the VEIP slot row says when it has no effect: omcid applies the slot
  only while `OMCI_CUSTOM_ME` has bit 256, the stock default of that key does
  not, and it is read-only on the Stock keys tab. The row shows the value to
  set with `flash set`. The reset, restore and counts text no longer say the
  `OMCI_CUSTOM_*` masks are read only by the stock firmware (omcid reads one
  bit of `OMCI_CUSTOM_ME`), and the "21 of 184 keys" figure is corrected
  (22 of the 184 stock keys, plus keys of the image's own).

- This changelog no longer cites files of a private workspace.

- No OLT or ONT make is named in the UI or its fixtures. The MIB tab lists the
  six entities the stock firmware registers under such names as
  `PrivateQueueMap`, `Me350`, `Me370`, `Me373`, `PrivateMcastTag` and
  `PrivateSntp` and queries them by class id (243, 350, 370, 373, 65282,
  65294); the Services card shows the OLT vendor code as the four characters
  the OLT reports, without a name lookup. Released sections of this file are
  unchanged. Refs odi-oss#114

- Security and robustness, from the night audit: a request now has a ten-second wall-clock deadline and the upload
  body two minutes, where before only each single read was bounded (15 s), so
  one client sending a byte every few seconds held the single-threaded daemon
  (and the Firmware tab during an update) indefinitely. `POST /api/upload` is
  refused with 409 while `fwu_starter.sh` has a write running, because the
  flasher reads that same file for the eighty seconds it takes and a second
  upload truncated it under it; the file is created fresh (`O_EXCL`) instead
  of opened through whatever is at the path; bytes beyond the declared
  `Content-Length` are no longer counted as still to come (a subtraction that
  wrapped and copied whatever followed into `/tmp` until it was full). A
  form value that does not fit its buffer is an error instead of being cut:
  `/api/config` answers it per key (`the value is too long ...`) and no longer
  reports `ok` for a truncated `OMCI_FIXED_ME`; a long value of one key no
  longer hides `_confirm=identity` after it.
- Firmware upload: the size limit is 6 MiB, not 8. `/tmp` is a tmpfs the image
  caps at 8 MiB, so an upload of exactly the old limit filled it and left no
  room for the flasher's own files or for `flash set`, which stages its temp
  file there. A real image (kernel plus rootfs partition, about 3.8 MiB) is
  well under the new limit. Found in an audit of the update path.
- Robustness, from the night audit: a child confd
  runs can no longer hold the whole daemon after its output ends. The drain
  kept nothing past a full buffer and then waited for the child with a
  blocking `waitpid()`, so a command that printed more than the buffer
  (`omcicli mib get` on a big MIB) and then stalled froze every request; it
  now keeps reading and discarding under the same inactivity bound, and a
  child that closes its output but does not exit within two seconds is
  killed and reported as a timeout like any other. Children also start with
  SIGPIPE at its default action again: the daemon ignores it for itself and
  an ignored signal survives `execve`, so scripts ran with it ignored.
- Security and robustness, from the night audit:
  `/etc/config/confd.auth` and the ssh `authorized_keys` are written to a
  temporary file beside them and renamed into place, instead of truncated and
  rewritten. A power cut during a password change used to leave an empty
  credential file, which the UI reads as "no credential" and answers with the
  default one; during a key change it left a truncated key file on an image
  that has no password login. `delete=` on `/api/sshkeys` with anything but a
  line number is now a 400; it used to delete line 0 (`delete=abc`) or the
  leading digits (`delete=1x`).
- Security, from the night audit: confd answers only
  requests whose `Host` is a name a browser can only have reached on the LAN: an
  IP literal, a single label, or a private suffix (`.local`, `.lan`, `.home.arpa`
  and the like). Any other name gets 403 before the password prompt, which stops
  a web page from reaching the stick through DNS rebinding (the page then looks
  same-origin to the browser and could drive every route with the default
  password). A site that gives the stick a public-looking name lists it in
  `/etc/config/confd.hosts`, one per line. A request that a browser marks
  `Sec-Fetch-Site: cross-site` or `same-site` is refused unless it is a followed
  link, so a page cannot make the browser fetch routes such as the diagnostics
  bundle. Every response now carries `X-Frame-Options: DENY`, a CSP
  `frame-ancestors 'none'`, `nosniff` and `Referrer-Policy: no-referrer`, so the
  page cannot be framed under an operator pointer.
- Tests and docs: the two lines are called ISP1 and ISP2 in the OMCI fixtures
  (files renamed `*-claro.txt` to `*-isp1.txt` and `*-vero.txt` to `*-isp2.txt`),
  the web checks, AGENTS.md and comments, and the fixture README no longer
  names an OLT vendor. Released sections of this file are unchanged.
- Config, Expert settings: three new controls for what the stick presents to
  the OLT (odi-oss #104 has the keys): *Create a VEIP* (`OMCI_VEIP`, a select:
  create, the default, or none for a PPTP-only ONU), *VEIP slot*
  (`OMCI_VEIP_SLOT_ID`, the stock key, a number from 2 to 254, with its
  dependence on bit 256 of `OMCI_CUSTOM_ME` in the help) and *Vendor-private
  entities* (`OMCI_PRIVATE_ME`, a select: create, the default, or leave out
  entities 350, 370 and 373). Each re-registers the ONU, so the page offers
  *Apply now* behind the confirmation. The VEIP slot key moved from the Stock
  keys tab to Expert settings.

- Docs: docs/DESIGN.md describes the safe-mode, safe-mode-record and boot
  fallback bars (the same striped band as the trial-boot bar) and the
  "Locked out? The safe mode" help on System > Access; docs/API.md lists
  `/api/hostlink`.

## v1.4.0 - 2026-10-15

- The `meta.tsv` buffer in confd is 24 KB instead of 16 KB. The table had grown
  to 16.6 KB with the new keys, past the old buffer, and confd silently dropped
  the last rows (their help, options and ranges) on the device; `make check`
  caught it.

- Config, Network: a Host port control for the odi-only key `HOST_AUTONEG`
  (odi-oss: host port auto-negotiation, on by default, off forces
  1000BASE-X full duplex for a router port with auto-negotiation off). It
  never stores the key: Try runs `host-autoneg.sh try on|off`, the image
  applies the mode a second later in RAM, and a dialog counts the two-minute
  window down ("Keep this setting? Reverting in N s"); Keep runs `confirm`,
  Revert runs `revert`, and with no answer the image goes back by itself.
  The dialog polls the stick and says when it stops answering. New route
  `/api/hostlink`: GET reads the state the image keeps (`/var/run/host-autoneg`,
  the safe-mode flag and record, the host link) with no fork; POST runs one
  of four fixed verbs (try, confirm, revert on host-autoneg.sh; ack on
  safe-mode.sh), bounded at 20 s. `HOST_AUTONEG` is `writable=never` in the
  schema, so Save and Restore cannot write it, and it is on neither the
  Network nor the Stock keys list.

- A banner on every view, beside the default-password one, when the image
  changed what runs by itself: the boot fallback (`HOST_AUTONEG` is off but
  this boot found no host link forced; clears by itself at the next boot
  that brings it up), a safe-mode boot (odi-oss: the fibre off, the host
  port on auto-negotiation, the default password for that boot only; the
  banner says so and how to leave: set a password if lost, acknowledge,
  reboot), and a past safe-mode boot nobody acknowledged yet (an
  Acknowledge button, which runs `safe-mode.sh ack`).

- The safe-mode and boot-fallback banners are now the same full-width striped
  band as the trial boot, one short line each, stacked under it: "Safe mode.
  A recovery boot: the fibre (PON) is off and the default passwords work for
  this boot only", with Details and Acknowledge; after Acknowledge the bar
  stays for that boot, without the button, and says the next boot is normal;
  a later boot with an unacknowledged record says the build and the number of
  short power cycles. The long explanation (what the mode does, how to leave
  it, how to enter it, the trade-off) moved to "Locked out? The safe mode" on
  System, Access, which Details opens. The Host port block on Config, Network
  is now drawn as the other settings rows (label and help on the left, the
  buttons on the right, status as compact key/value rows, the unreachable-stick
  note as a Details disclosure) instead of a lone button in a full-width card.

- How to enter the safe mode, on System, Access ("Locked out?") and under
  Host port: plug in, wait about 80 seconds, pull, wait a few seconds;
  five times (three with the host port forced); then leave it in. The
  window is roughly 60 to 110 s after power-on, since about 54 s pass
  before the kernel starts (measured; it can vary by board). The banner no
  longer says the power-ups were under a minute: they are cut about 80 s
  after power-on, before the boot itself has run a minute.

- Safe mode: on a safe-mode boot (`/var/run/safe-mode`) the web UI accepts
  the built-in `admin:admin` instead of the saved credential, in memory
  only: `confd.auth` is not read and not touched, a password saved meanwhile
  is written to it and in force from the next boot, and the page reports
  the default as in force. `/api/hostlink` adds `safemode_now`, the flag of
  the boot, beside `safemode`, the record (now `/etc/config/safe-mode`).

- Config: an *Expert settings* disclosure, collapsed, at the foot of the ONU
  identity subtab. It warns that its keys change how the stick presents itself
  to the OLT, and holds `OMCI_UNKNOWN_ME_OK` and `OMCI_FIXED_ME`, moved out of the
  identity list. `OMCI_FIXED_ME` is now a table editor, one row per entry (class, instance, attribute,
  bytes), with Add entry and Remove, checked as you type against the rules the
  daemon enforces; the form that answers every instance shows `any` in
  instance and attribute. Saving and applying are unchanged. The key takes a
  second entry form, `CLASS:INSTANCE:ATTR:HEX` (instance 0-65535, decimal or
  `0x`; attribute 1-16), which makes an entity that exists only at that
  instance, and the limit is 16 entries. confd (type `fixedme`), the browser
  check and the help text follow. The entry form needs an odi-oss image whose
  omcid reads it (odi-oss, same batch); an older omcid turns the whole key off.

- Config: `OMCI_ACCEPT_REBOOT` gains a third option, `2` acknowledge only: the
  OLT Reboot is answered with success and the stick does not reboot. The
  help text says so.

## v1.3.2 - 2026-10-14

- Config: a select whose key is unset showed an empty box. The image always
  does something without a key, so a new settings.tsv column `unset` names
  that value for every key with options (`OLT_SW_DOWNLOAD` accept;
  `OMCI_UNKNOWN_ME_OK`, `OMCI_ACCEPT_REBOOT`, `LAN_ENABLE_IP2`,
  `VLAN_CFG_TYPE` and `VLAN_MANU_MODE` 0), and the page shows it selected,
  never "(not set)" and never an option to unset; choosing it stores
  nothing. scripts/check-schema.py requires the column for those keys.

- Config: the odi-only key `OMCI_ACCEPT_REBOOT` on the ONU identity subtab, a
  yes/no field: "Lets the OLT reboot the stick over OMCI. Off by default."
  Live, nothing to apply: omcid reads it each time a Reboot arrives. Needs an
  odi-oss image that knows the key; older images keep the value and ignore it.

## v1.3.1 - 2026-10-14

- Config: the odi-only key `OMCI_FIXED_ME` on the ONU identity subtab, up to
  8 `CLASS:HEX` entries (class 1-65535, 1 to 25 bytes of hex, optional `0x`,
  no class twice, e.g. `200:0x0011aa,201:01020304`). omcid answers an OLT Get
  of a class it has no model for with that entry's bytes; an implemented
  class is never overridden. Empty clears it, it re-registers the ONU like
  `OMCI_UNKNOWN_ME_OK`, and a malformed list is refused in the browser and in
  confd (new type `fixedme`) because omcid would turn the whole key off. The
  bytes are never logged. Pairs with odi-oss #88.
- Config: the "OLT identity" subtab is now "ONU identity". Its keys
  describe the stick (what it reports to the OLT), not the OLT, which a
  reader of the old name found misleading.

## v1.3.0 - 2026-10-13

- fix: the Commit button (`action=commit`) now runs `nv commit <slot>` and
  then `/etc/scripts/slot-state.sh`. It used to run `nv setenv sw_commit`,
  which writes one copy of the U-Boot environment and leaves the other
  naming the old slot, and nothing refreshed `/var/run/odi-slot`, which is
  written once at boot. So `OdiUncommittedImage` (the exporter's
  `gpon_uncommitted`) kept firing on a stick that had just been committed,
  and the login notice stayed. `nv commit` refuses a slot that is not the
  running one and verifies both copies; its reason is shown when it refuses.
  The reply carries `refreshed`, false when the state file could not be
  rewritten (the commit stands). The stock `nv` has no `commit` verb, and
  there the old single `nv setenv` is still used, and the note says one copy.
  Pairs with odi-oss `slot-state.sh` setting its own `PATH` and not waiting
  for syslogd on a re-run (odi-oss v1.4.0, #64); an older image still works, its
  script only lacks both. Smoke cases cover the success, the refusal, the
  failed refresh and the stock nv.
- Config: a key the firmware ignores in the current mode is shown without a
  control or a value ("Not used in this mode"), with the reason and the key
  to change first; the stored value is under Details. The VLAN ID and
  priority used to stay editable in VLAN config mode 0 and failed validation
  when cleared, so the page seemed to require a value nothing reads
  (odi-oss #29). The condition follows pending edits: choosing mode 1 unlocks
  the fields before saving, and setting it back drops an edit typed there.
  Save refuses any such edit left over; the daemon still accepts the keys, so
  a backup restore writes them as before.

## v1.2.1 - 2026-10-12

- fix: on odi-oss the Config page showed `SYSLOG_SERVER` and `NTP_SERVER` empty
  after a reload, although they were saved and `flash get` returned them.
  `flash all cs` prints the odi-only keys after the last table block, and the
  `flash all` parsers never left table context on `</Dir>`, so those keys were
  read as table values with no index and dropped. `/api/values` (src/mib.c),
  `gen-schema.py`, `capture-baseline.sh` and `schema-drift.sh` now end table
  context on `</Dir>`. The store never nests Dirs, so no stack is needed.
  New `scripts/parser-check.sh` (in `make check`) and a smoke case cover it.
- docs: repair text merged into duplicated entries by union-resolved rebases.
  The v1.1.0 section described `/api/firmware` `slots` and `fallback` twice
  and the diagnostics bundle download twice (once as on the Admin tab, once
  as on System > Logs & tools); each is now one entry, worded for the
  redesigned UI.
- AGENTS.md has a release checklist: every change since the last tag has an
  entry, no merge debris, `Unreleased` moved into the tag section, and the
  published notes checked.

## v1.2.0 - 2026-09-29

### Added
- Config rows for the keys odi-oss added: `ONU_HW_VERSION` (ONU hardware
  version, the ONU-G version some OLTs whitelist; at most 14 printable ASCII
  characters, empty removes the key; INTERRUPTS INTERNET), `OLT_SW_DOWNLOAD`
  (Firmware pushed by the ISP: accept answers and discards the image, reject
  refuses it, nothing is ever installed; LIVE, read at each download step) and
  `OMCI_UNKNOWN_ME_OK` (answer unknown entities with success; off by default,
  the risk stated in the help; INTERRUPTS INTERNET), all on the OLT identity
  subtab. New schema type `ascii14` for the first, the only odi-only key that
  can be cleared besides the `hostport` ones, and settings action `none` for a
  live key with nothing to run.
- `/api/config` answers `"interrupts"` beside `"needs"`: whether the `omci`
  action drops the fibre service (false when every key of the batch is LIVE).
- A light/dark toggle at the top right of the header, next to Sign out: a sun
  or a moon (inline SVG, no fetch) for the mode it switches to. The page still
  follows the browser's colour scheme until you pick; the pick is kept in
  localStorage (`odi-theme`) and applied from the head before first paint, so
  it does not flash. It works with storage blocked, for the page only.

### Changed
- The four VLAN keys (`VLAN_CFG_TYPE`, `VLAN_MANU_MODE`, `VLAN_MANU_TAG_VID`,
  `VLAN_MANU_TAG_PRI`) are LIVE now, not INTERRUPTS INTERNET: odi-oss omcid
  rereads the store on SIGHUP and rebuilds the bridge connections in place,
  with the ONU staying in O5, so a save applies them at once with no
  confirmation. The action stays `omci`, since `apply.sh omci` is what sends
  the signal; a batch that also carries an identity key still offers *Apply
  now* behind the confirmation, which now says omcid clears its MIB and
  re-ranges the ONU rather than restarts. `GPON_SN` moves from REBOOT to
  INTERRUPTS INTERNET with the same action: the odi-oss driver now rewrites
  the serial into the PON MAC while the ONU is deactivated, which is what the
  re-registration does. It is not verified on a stick yet.
- `VLAN_MANU_MODE` reads "1 — Stick tags" and "0 — Router tags
  (transparent): service stops unless the router tags", and its help says who
  tags the service in each. Every value that can cut the service says so in
  its option label (`VLAN_CFG_TYPE` 0, `OMCI_UNKNOWN_ME_OK` 1, `LAN_ENABLE_IP2`
  off), `OLT_SW_DOWNLOAD` says neither value touches the service, and the first
  line of the help, the one shown without Details, says how a wrong value cuts
  it for the service VLAN ID, the serial number, the PLOAM password and the
  LOID. The identity keys and the identity switch say an OLT that expects
  another identity can leave the ONU in O5 with no service.
- A save of the LIVE VLAN keys that would stop the stick tagging, start it, or
  move it to another VLAN asks first, as a Live change, and says what happens
  to the traffic (the ONU stays in O5, so nothing else would); declining writes
  nothing. A priority change alone does not ask.
- An identity key saved while the identity switch is off costs nothing: omcid
  does not report it, so it does not re-register. The save bar no longer
  counts it as INTERRUPTS INTERNET, the page does not offer *Apply now* for
  it, and the row's warning says the service is not dropped.
- `scripts/check-schema.py` fails when a schema table outgrows the confd
  buffer it is read into (`src/buffers.c`): `read_file()` stops one byte short
  without an error, so the tail rows would lose their options and help on the
  device only.
- Receive is now read at the same size as Transmit (44 px at most, was 52 px):
  one size, weight and unit style for both readouts.

## v1.1.1 - 2026-09-29

### Changed
- "Keep" is now "Commit" everywhere: the trial banner offers Commit to this
  image, the running slot Commit to partition N, the default slot is badged
  Committed, and the confirmations say what committing means. System >
  Firmware explains it under the partitions (What committing means): U-Boot
  boots the committed partition by default, a trial is one-shot, committing
  makes the running image the default, and a committed image that later fails
  keeps booting itself.
- The trial banner no longer says what the other partition holds (it is not
  always the stock firmware): "This image (partition 1) is not committed. The
  next reboot returns to partition 0." System > Firmware shows what each holds.
- The receive readout is smaller (52 px at most, was 76), closer to transmit
  (44 px), so it leads the Status page without dominating it.

- Screenshots retaken, with three new ones: `ui-mactable.png` (forwarding
  and learned addresses), `ui-trial.png` (the trial banner) and
  `ui-committing.png` (Firmware during a trial, the commit explanation open).
  The file names are stable; odi-oss links to them.

### Fixed
- Forwarding rates show at most two decimals; below 1 kB/s they printed the
  raw float.
- OMCI > Services: T-CONTs with Alloc-ID 255 (G.988: no Alloc-ID assigned on
  G.984; 65535 on later PONs) are counted as unassigned, not provisioned, so
  a line with five in use reads "5 assigned: 282, 794, 1050, 1306, 538" and
  "11 unassigned" instead of "16 provisioned".

## v1.1.0 - 2026-09-29

### Changed
- The web UI is redesigned. Four sections with subtabs replace the eight flat
  tabs: Status; Config (Line, VLAN, OLT identity, Network, Services, Stock
  keys); OMCI (Services, MIB browser); System (Firmware, Access, Backup &
  reset, Logs & tools). The hash names the view (`#config/vlan`), old tab names
  still land, and both levels are keyboard tablists.
- Settings rows show a label, one line of help and a Details disclosure,
  beside the control and its cost; on a phone they stack, and the page no
  longer scrolls sideways. The four apply classes share one badge (one to four
  bars in the class colour) on each key, in the sticky save bar ("3 changes",
  "2 interrupts internet", "1 live"), on the apply buttons and in the
  confirmations. Subtabs count their unsaved changes.
- The receive and transmit levels are drawn as instruments: the reading on the
  class B+ window, with the margin to each edge as dimension lines, and a
  verdict (in window, near the edge, out of window). Near the edge is the
  outer 16% of each window (about 3 dB receive, 0.7 dB transmit); the windows
  are the ONU class B+ figures from ITU-T G.984.2 Amendment 1. A header pill repeats the
  ONU state and receive level on every view.
- New palette from the fibre world (singlemode yellow, APC green, UPC blue,
  alarm red on cool slate), with a light theme following
  `prefers-color-scheme`, checked for WCAG AA. Readouts use a 2.4 KB subset of
  B612 Bold (SIL OFL), embedded in `style.css`; nothing is fetched.
- Long explanations moved behind disclosures next to what they explain; the
  per-tab "Why this device behaves this way" blocks and hover popovers are gone,
  their text kept.
- The default-password banner shows on Status and System > Access; elsewhere it
  is a small header chip.

### Added
- `GET /api/diag` and a "Download a diagnostics bundle" button on System >
  Logs & tools: confd runs the image `/etc/scripts/diag-bundle.sh` (odi-oss),
  which collects logs, the previous boot ramlog, dmesg, slot variables, an exporter
  scrape and the config with every secret redacted, and streams the tar.gz it
  wrote (up to 2 MiB, then removed). Bounded at 60 s
  (`DIAG_BUNDLE_TIMEOUT_MS`); a failure or timeout is a 500 carrying the
  script message, an image without the script a 501. Needs an odi-oss image
  that ships `diag-bundle.sh`. Covered by `make smoke` against a stub script.
- A trial-boot band in the header on every view while `sw_commit`, in either
  environment copy, names another slot than the running one: where the next
  reboot goes, what that slot holds, and Keep this image (the existing commit).
  Not dismissible.
- `/api/firmware` reports `slots` (each kernel partition's uImage name and
  build time, read from the mtd device found by name in `/proc/mtd`; `{}` when
  it cannot be read) and `fallback` (the sw_* of `nv fallback`, the other copy
  of the redundant U-Boot environment; empty on the stock `nv`). The Firmware
  view names what each slot holds from that, not from U-Boot `sw_version<p>`,
  and when the other slot holds the stock firmware it says that writing
  replaces it and loses it as a fallback, and asks a second time.
- Kernel log: heartbeat lines (`rcS: alive`, `odi_wdt: alive`) are hidden by
  default and counted, with a checkbox to show them; levels render as words.

### Fixed
- Config help was printed twice where `meta.tsv` and `settings.tsv` said the
  same thing (SYSLOG_SERVER, NTP_SERVER, the identity keys, the VLAN ID). The
  duplicated sentences are removed from the data, and the page drops a note
  sentence the help already said.
- OMCI Services: the parser reads the odi-oss omcid dump shape (`268
  GemPortCtp 1`, raw attribute bytes, `N rows`), so GEM ports are listed instead
  of "The OLT has not created any". An empty read of an entity the ONU creates
  itself (software image, OLT-G, T-CONT) is shown as "Could not read", never as
  none; each card shows reading, could not read, none, or its rows.
- Kernel log: `<12>`-style userland priority prefixes (facility and level) are
  stripped and the level read from the low three bits; the stale "there is no
  syslog here" note is replaced.
- Firmware: an override is recognised by the path the running confd was started
  from (`/api/firmware` now reports `exe`), not by comparing build ids, so a local
  build (`confd=local` in `/etc/odi-build`) is no longer called an override.
  Try is offered only on the slot not running; the running, uncommitted slot
  offers Keep this image, the same action as the trial banner.
- The Reboot button reads "Reboot" with its cost badge, not "Reboot now —
  REBOOT"; the SSH key Remove button matches the other buttons.

## v1.0.8 - 2026-09-28

### Fixed
- `SYSLOG_SERVER` and `NTP_SERVER` can be cleared from the Config page: an empty
  value is accepted for `hostport` keys, by confd and by the page. Needs
  odi-oss v1.0.8 or later, whose `flash` stores these two keys in
  `/etc/config/odi.conf` and removes the key on an empty value. Other keys still
  refuse an empty value.

## v1.0.7 - 2026-09-28

### Added
- `SYSLOG_SERVER` and `NTP_SERVER` are set from the Config page (under
  "other") and apply as SERVICE RESTART: after the save the page runs
  `apply.sh syslog` / `apply.sh ntp` through `/api/apply`, which kills the
  daemon so busybox init respawns it and it rereads the store. The run is
  bounded by the same `APPLY_TIMEOUT_MS` as every other apply. The fibre
  service is not touched. Both keys have a new `hostport` schema type
  (IPv4 literal or hostname, optional `:port` 1-65535; no spaces or quotes),
  checked by confd and by the page, and rows in `settings.tsv`.
  `/api/apply` accepts `what=syslog` and `what=ntp`, and a save reports them
  in `needs`. Note: confd refuses an empty value, so a key cannot be cleared
  from the page.

## v1.0.6 - 2026-09-28

### Fixed
- Bounded every wait confd does on a forked child (`omcicli`, `diag`,
  `flash`, `apply.sh`, `fwu_starter.sh`, `nv`, `ping`, `md5sum`, `mkdir`) with
  a per-command timeout: past it the child is SIGKILLed and reaped instead of
  leaving the daemon parked in `read()`/`waitpid()` forever, which would
  freeze every other request behind it (confd is single-threaded). Mirrors a
  fix in the sibling `odi-sfp-exporter` for the same failure mode (a stuck
  `omcid` left a child never answering). Also bounded the host-side
  `scripts/deploy.sh`, `capture-omci.sh`, `capture-baseline.sh` and
  `schema-drift.sh` ssh sessions with `ConnectTimeout`/`ServerAlive*`, which
  had none.

## v1.0.5 - 2026-09-25

### Added
- Pinned the shared `odi-toolchain` build image by digest instead of a
  floating tag.

### Changed
- Reordered the config sections, added a MIB class picker, and swept the
  deployment text for accuracy.
- Relicensed the project GPL-2.0-only, matching the kernel it runs
  alongside.

## v1.0.4 - 2026-09-24

### Added
- Enabled the MAC table on odi-oss and show multicast groups in it.

## v1.0.3 - 2026-09-24

### Fixed
- Corrected the smoke suite oversized-body check to send 20 KB instead of
  64 KB.

## v1.0.2 - 2026-09-24

### Added
- Added a release workflow and `make assets`/`make sums`/`make release`
  targets, mirroring `sfp-exporter`.
- `AGENTS.md`: guidance for coding agents working in this repo.
- README: documented the SSH keys section (Admin tab, `/api/sshkeys`, the
  key file and its `-D` contract).
- odi-oss: show only the config keys the image actually reads, each with
  its apply class.

### Changed
- `make assets` now runs inside the build container, since `build/` ends up
  root-owned on Linux runners.

### Fixed
- A confd whose build stamp does not match its tag is now refused at
  publish time, instead of shipping silently.

## v1.0.1 - 2026-09-21

### Added
- SSH public keys for device login: `/api/sshkeys` (list, add, delete) and
  an SSH keys block on the Admin page. Keys live in
  `/etc/config/dropbear.d/authorized_keys`, paired with an odi-oss image
  that starts dropbear with `-D` on that directory.

## v1.0.0 - 2026-09-12

First tagged release of `confd`, the web configuration UI for the ODI
DFP-34X-2C2 (Realtek RTL9601D/RTL9602C): a freestanding, static, big-endian
MIPS-I binary with no libc and no PIC.

### Added
- Read-only and then read-write configuration UI for the device, with
  everyday and advanced config tabs, field-level guidance (labels, options,
  ranges and dependencies), and a picker for OMCI ME classes.
- Firmware tab: upload and write a firmware image from the page, and surface
  the version chain, the `RX_LOS` trap, and the auth difference between
  images.
- OMCI MIB pages: a decoded Services view and a raw MIB view, plus decoding
  of the `OMCI_CUSTOM_*` feature bitmasks from the image own symbol tables.
- Tools tab: the kernel log, and ping from the stick.
- Admin: set the config UI password from the page (creating the credential
  file if needed), with a built-in `admin`/`admin` fallback when none
  exists yet.
- One-click config backup, and restore from a backup, from the page.
- Reset the service configuration from the page, with an automatic backup
  first.
- Show the switch's learned addresses.
- Serve the image build manifest, so the UI can show what it is actually
  running.
- `make verify` (ELF shape plus the RLX5281 instruction audit), `make check`
  (the data files checked against each other) and `make smoke` (the daemon
  run under qemu, 131 HTTP checks) as the non-device test gate.

### Changed
- Split the UI into modules served from an allowlist, and split `confd.c`
  into translation units, then turned on LTO to recover the code size that
  split cost.
- Centred the tabs, dropped the hostname from the chrome, and documented
  uploading an image.

### Fixed
- Made the request parser read a whole request and fail closed on anything
  else it does not recognize.
- Made `verify` and `BUILD_ID` real dependencies of the build, so a stale
  build stamp can never ship.
- Computed deploy space checks from the actual files against the jffs2
  compressed layout, instead of raw byte counts, and stopped inventing
  VLAN 0.
- Fixed rendering bugs found by reading through the page, and stopped
  `/api/l2` from hanging.
