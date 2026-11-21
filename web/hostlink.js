/*
 * The host port: auto-negotiation with the router on the SFP edge
 * (odi-oss HOST_AUTONEG), and the banner that says when the image changed it
 * by itself.
 *
 * A wrong mode takes down the only way into the stick, so the page never
 * stores the key. "Try" asks host-autoneg.sh for a trial: the image applies
 * the mode a second later, in RAM, and reverts it by itself at the end of the
 * window unless "Keep" (confirm) arrives first. Keep can only arrive over the
 * link being tried, which is the point: a mode that breaks the link cannot
 * be kept. The dialog counts the window down and polls the stick; a poll
 * that fails says the link may be down in this mode, and that the stick
 * reverts by itself.
 *
 * The SerDes mode of the same port (odi-oss HOST_SERDES) is the second control
 * here, and works the same way through host-serdes.sh: Fiber 1G (the default),
 * 2.5G or HiSGMII, a trial the image reverts by itself, a dialog that counts
 * it down. While the mode is not Fiber 1G the image refuses an auto-negotiation
 * trial, and the control says so. The link comes from the script's `status`
 * (which says where it was read from: only the port link in Fiber 1G, the
 * link sync in 2.5G, nothing in HiSGMII), asked for after the page is up so
 * the banner stays a no-fork read.
 *
 * The banner covers the states in which the image changed what runs by
 * itself, so none goes unseen:
 *   - the boot fallback: HOST_AUTONEG is off, this boot found no host link
 *     forced and the link came up only with auto-negotiation. It clears by
 *     itself at the next boot that brings the forced link up;
 *   - the SerDes boot fallback: HOST_SERDES is 2.5G, this boot saw no link in
 *     it and runs Fiber 1G to stay reachable; the setting is kept;
 *   - a safe-mode boot (odi-oss safe-mode.sh): a run of short power-ups,
 *     watchdog resets in a row or an unusable config partition made this
 *     boot a recovery boot, with the PON off and the host port on
 *     auto-negotiation, for this boot only. The default password is open
 *     only when a power cycle led into it (login=default in the flag, or
 *     no login= line on an older image); login=stored keeps the saved one.
 *     It reboots by itself (exit_at=, an uptime) unless acknowledged
 *     (exit=held);
 *   - a safe-mode record: a safe-mode boot happened and nobody acknowledged
 *     it yet. It stays until acknowledged, from the banner;
 *   - a recreated config store (odi-oss config-reseed.sh): the config
 *     partition was erased, and the boot rebuilt the store from the image
 *     defaults with the serial number empty, so the stick stays off the PON
 *     until it is set. It stays until acknowledged, from its own bar.
 */

import { $, el, get, ask, once } from './dom.js';

const POLL_MS = 3000;
let H = null;          /* the last /api/hostlink answer */
let tick = 0;          /* the countdown interval, while a trial dialog is up */
let polling = false;
let SS = null;         /* the last host-serdes.sh status answer, key by key */
let ssBusy = false;
let kind = 'autoneg';  /* which trial the dialog is about: autoneg or serdes */

const modeText = (m) => (m === 'off' ? 'off (forced 1000BASE-X full duplex)' : 'on');

/* The SerDes modes, as the image names them in the key and as the page says them. */
const SERDES = {
  fiber1g: 'Fiber 1G (1000BASE-X, default, most compatible)',
  '2500basex': '2.5G (2500BASE-X)',
  hisgmii: 'HiSGMII',
};
const serdesText = (m) => SERDES[m] || (m ? String(m) : 'unknown');
const serdesShort = (m) => (m === 'fiber1g' ? 'Fiber 1G' : m === '2500basex' ? '2.5G (2500BASE-X)' : m === 'hisgmii' ? 'HiSGMII' : m);
const sdState = (h) => (h && h.serdes && h.serdes.state) || {};
const sdOn = (h) => !!(h && h.serdes && h.serdes.supported);
/* Where the image read the host link from, in words. */
const SOURCE = {
  host_link: 'the port link',
  serdes_sync: 'the host link sync',
  none: 'no signal in this mode',
};

/* Which trial is running, if any: the SerDes one first (the image allows one
   at a time, so there is never both). { kind, st } or null. */
function trialOf(h) {
  if (sdState(h).phase === 'trial') return { kind: 'serdes', st: sdState(h) };
  const st = (h && h.state) || {};
  return st.phase === 'trial' ? { kind: 'autoneg', st } : null;
}

/*
 * What the bars say for a /api/hostlink answer:
 *   { show, safe, fallback, ack, reseed }
 * safe is the text of the safe-mode bar (or null), fallback that of the boot
 * fallback bar (or null), ack whether the safe bar offers Acknowledge, reseed
 * the text of the recreated-store bar (or null; it always offers
 * Acknowledge). One short line each: the long explanation of the safe mode
 * is under System, Access. Pure, so make check can drive it with fixtures.
 */
function bannerText(h) {
  const out = { show: false, safe: null, fallback: null, ack: false, reseed: null };
  if (!h) return out;
  const st = h.state || {};
  const now = h.safemode_now;
  const rec = h.safemode;
  /* cleared is a list: HOST_AUTONEG, HOST_SERDES, OMCI_UNI_LOCK, joined
     with commas, or none or failed. */
  const cleared = (s) => {
    const l = String((s && s.cleared) || '').split(',');
    const an = l.includes('HOST_AUTONEG'), sd = l.includes('HOST_SERDES');
    const ul = l.includes('OMCI_UNI_LOCK') ? ' It also turned off "Honour an OLT lock of the Ethernet port".' : '';
    if (an && sd) return ' It also cleared the host port settings (auto-negotiation and link mode).' + ul;
    if (sd) return ' It also cleared the host port link mode.' + ul;
    return (an ? ' It also cleared the host port setting.' : '') + ul;
  };
  if (now) {
    /* An image without the timed exit writes no exit= line: there the
       record is all an acknowledgement removes. */
    const timed = now.exit === 'timed', held = now.exit === 'held';
    const acked = held || (now.exit === undefined && !rec);
    /* What boots next is not this page's to promise: an armed trial, or a
       config partition that is still unusable, decide that. */
    let end = '';
    if (timed) {
      end = ` It reboots${exitWhen(now)} unless acknowledged.`;
    } else if (now.exit === 'exiting') {
      end = ' Nobody acknowledged it: it is rebooting now.';
    } else if (acked) {
      end = held ? ' Acknowledged: it stays up until you reboot.'
        : ' Acknowledged: the next boot is a normal boot.';
    }
    out.safe = 'Safe mode. A recovery boot' + WHY[now.cause || ''] + ': the fibre (PON) is off and '
      + loginText(now)
      + cleared(now) + end;
    out.ack = !!rec || timed;
  } else if (rec) {
    const build = rec.build ? `build ${rec.build}, ` : '';
    const after = rec.cause === 'watchdog' ? `after ${rec.wdt_resets || 'several'} watchdog resets in a row`
      : `after ${rec.short_boots || 'several'} short power cycles`;
    out.safe = `A safe-mode boot happened (${build}${after}).` + cleared(rec);
    out.ack = true;
  }
  const ss = sdState(h);
  if (sdOn(h) && ss.fallback === '1' && ss.setting && ss.setting !== 'fiber1g' && ss.running === 'fiber1g') {
    out.fallback = `Host mode fallback. The host port is set to ${serdesShort(ss.setting)}, but this boot saw no `
      + 'link in it, so the stick runs Fiber 1G to stay reachable. The setting is kept.';
  } else if (h.supported && st.fallback === '1' && st.setting === 'off' && st.running === 'on') {
    out.fallback = 'Host link fallback. The host port is set to auto-negotiation off, but this boot the link '
      + 'did not come up that way, so the stick runs auto-negotiation on to stay reachable. The setting is kept.';
  }
  out.reseed = reseedText(h.reseed);
  out.show = !!(out.safe || out.fallback || out.reseed);
  return out;
}

/* Why this boot is a safe-mode boot, for the bar. Short boots need no word:
   the person who made them knows. */
const WHY = {
  '': '', short_boots: '',
  watchdog: ' the stick entered by itself after repeated resets',
  config: ' the stick entered by itself because its settings partition cannot be used',
};

/* Whether a safe-mode flag opens the default credentials: every flag does
   except one that says login=stored (odi-oss writes it when no power cycle
   led into the safe mode). An older image writes no login= line and opens
   them always, which is what confd does with such a flag too. */
const defaultLogin = (now) => !!now && now.login !== 'stored';

/* Which passwords a safe-mode boot answers to, for the bar. root over SSH is
   said apart from this page: root_password=failed is a boot whose web login
   is the default while root kept its own account (the image could not put
   the default one in place). An older image writes no root_password line,
   or default. */
function loginText(now) {
  if (!defaultLogin(now)) return 'your saved password and SSH keys still apply.';
  if (now.root_password === 'failed') {
    return 'this page accepts the default password for this boot only; root over SSH does not (its saved login applies).';
  }
  return 'the default passwords work for this boot only.';
}

/* When a safe-mode boot reboots by itself, from exit_at (seconds of uptime):
   counted from its start, not from now, so a bar left open never says a
   time that has passed. Nothing when the flag does not carry a number. */
function exitWhen(now) {
  const at = Number(now.exit_at);
  if (!now.exit_at || !Number.isFinite(at) || at <= 0) return ' by itself';
  return at < 90 ? ` after ${at} seconds` : ` after ${Math.round(at / 60)} minutes`;
}

/*
 * The recreated-store bar, from the record config-reseed.sh keeps (null when
 * there is none). `files` names what was recreated: lastgood_hs.xml holds
 * the serial number, so with it the PON stays down; lastgood.xml alone holds
 * the PLOAM password and the other line settings. A record that names
 * neither is read as the worse case.
 */
function reseedText(rec) {
  if (!rec) return null;
  const l = String(rec.files || '').split(/\s+/);
  const cs = l.includes('lastgood.xml'), hs = l.includes('lastgood_hs.xml');
  const which = cs && hs ? ' (lastgood.xml and lastgood_hs.xml)' : hs ? ' (lastgood_hs.xml)' : cs ? ' (lastgood.xml)' : '';
  const head = `Settings recreated. The config store was missing at boot and was rebuilt from the image defaults${which}.`;
  if (cs && !hs) {
    return head + ' The PLOAM password and other line settings are back to their defaults: set them again or '
      + 'restore a backup.';
  }
  return head + ' The serial number is empty, so the stick stays off the fibre (PON) until you set it or restore '
    + 'a backup.';
}

function renderBanner() {
  const b = bannerText(H);
  const bar = (id, textId, text) => {
    $(id).hidden = !text;
    const p = $(textId);
    p.textContent = '';
    if (!text) return;
    const i = text.indexOf('. ');
    const head = /^(Safe mode|Settings recreated|Host link fallback|Host mode fallback)\./.test(text) ? text.slice(0, i + 1) : '';
    if (head) { p.append(el('strong', null, head), document.createTextNode(' ' + text.slice(i + 2))); } else p.append(document.createTextNode(text));
  };
  bar('#safebanner', '#safe-text', b.safe);
  bar('#reseedbanner', '#reseed-text', b.reseed);
  bar('#fallbackbanner', '#fallback-text', b.fallback);
  $('#hostlink-ack').hidden = !b.ack;
  $('#safe-password').hidden = !safeModeDefaultLogin();
}

/* The last /api/hostlink answer. */
function hostlinkNow() { return H; }

/* Whether this boot is a safe-mode boot: the flag, not an old record. */
function safeModeNow() {
  return !!(H && H.safemode_now);
}

/* Whether this boot is a safe-mode boot that answers to admin / admin. */
function safeModeDefaultLogin() {
  return defaultLogin(H && H.safemode_now);
}

/*
 * What the page says after a password was saved, for a /api/hostlink answer
 * h: two lines, the result and what other browsers do. A safe-mode boot on
 * the default login answers to admin / admin until it ends whatever was
 * saved, so the new credential is for the next boot, and the bar is named
 * only while it still waits for Acknowledge. One that kept the saved login
 * takes the new credential at once, like any boot. Pure, so make check can
 * drive it.
 */
function passwordSavedText(user, h) {
  const saved = 'Saved to /etc/config/confd.auth.';
  if (!(h && defaultLogin(h.safemode_now))) {
    return [saved, 'You stay signed in here. Any other browser signed in to this page is signed out, '
      + 'and signs in again as ' + user + '.'];
  }
  return [saved + ' From the next boot this page answers to ' + user + ' and the new password. '
      + (h.safemode || h.safemode_now.exit === 'timed' ? 'Acknowledge the safe-mode bar, then reboot.' : 'Reboot to use it.'),
    'You stay signed in here. Any other browser signed in to this page is signed out, and until the '
      + 'reboot signs in again with admin / admin.'];
}

/* Seconds left in the trial, from the stick's own clock: the deadline and the
   uptime come from the same /proc/uptime. */
function trialLeft(h) {
  const t = trialOf(h);
  const d = Number(t && t.st.trial_deadline), u = Number(h && h.uptime);
  if (!t || !Number.isFinite(d) || !Number.isFinite(u)) return null;
  return Math.max(0, d - u);
}

function renderBlock() {
  const box = $('#hostlink');
  if (!H || !(H.supported || sdOn(H))) { box.hidden = true; return; }
  box.hidden = false;
  const st = H.state || {};
  const ss = sdState(H);
  const sd = sdOn(H);
  /* In 2.5G and HiSGMII the port is forced and the image refuses an auto-negotiation trial. */
  const forced = sd && !!ss.running && ss.running !== 'fiber1g' && ss.running !== 'unknown';
  const now = $('#hostlink-now');
  now.textContent = '';
  const row = (k, v, cls) => {
    const r = el('div', 'setting');
    const ctl = el('div', 's-control');
    ctl.append(el('span', 's-ro' + (cls ? ' ' + cls : ''), v));
    r.append(el('div', 's-label', k), ctl);
    now.append(r);
  };
  /* The link as the image reports it: from the script's status when it came,
     else the port link the GET carries (which only means something in Fiber 1G). */
  const l = SS && SS.link ? SS.link : H.link === '1' ? '1' : H.link === '0' ? '0' : 'unknown';
  const link = l === '1' ? 'up' : l === '0' ? 'down' : 'unknown';
  const src = SS && SS.link_source && SOURCE[SS.link_source] ? ` (from ${SOURCE[SS.link_source]})` : '';
  if (H.supported) {
    /* While the link mode owns the port, the bit is the one it set: say so, as the image reports it. */
    const bit = SS && (SS.autoneg === 'on' || SS.autoneg === 'off') ? SS.autoneg : '';
    row('Auto-negotiation now', !forced ? modeText(st.running || 'on')
      : bit ? `${bit} (set by the ${serdesShort(ss.running)} link mode)` : 'not applicable in ' + serdesShort(ss.running));
    row('Stored setting', modeText(st.setting || 'on'));
  }
  if (sd) {
    row('Link mode now', serdesShort(ss.running || 'fiber1g'));
    row('Stored link mode', serdesShort(ss.setting || 'fiber1g'));
  }
  row('Host link', link + src, link === 'up' ? 'good' : link === 'down' ? 'bad' : '');
  if (st.phase === 'watch') row('Boot check', 'Still deciding the mode; try again in a minute.', 'warn');
  if (ss.phase === 'watch') row('Link mode boot check', 'Still deciding the mode; try again in a minute.', 'warn');
  if (st.message) row('Last event', st.message);
  if (ss.message) row('Last link mode event', ss.message);
  const busy = st.phase === 'trial' || st.phase === 'watch' || ss.phase === 'trial' || ss.phase === 'watch'
    || ss.phase === 'reapply';
  const other = (st.running || 'on') === 'off' ? 'on' : 'off';
  const btn = $('#hostlink-try');
  btn.textContent = other === 'off' ? 'Try auto-negotiation off' : 'Try auto-negotiation on';
  btn.dataset.mode = other;
  btn.disabled = busy || forced;
  $('#hostlink-an').hidden = !H.supported;
  $('#hostlink-an-na').hidden = !forced;
  /* After a fallback the stored mode comes back at the next boot, and so does the auto-negotiation it implies. */
  const fb = sd && ss.fallback === '1' && ss.setting && ss.setting !== 'fiber1g' && ss.running === 'fiber1g';
  $('#hostlink-an-fb').hidden = !fb;
  if (fb) {
    $('#hostlink-an-fb').textContent = `The stored link mode is ${serdesShort(ss.setting)}; this boot runs Fiber 1G after a `
      + 'fallback, so a change here lasts until the next boot.';
  }
  /* The fallback runs on while the setting says off: offer to keep on. */
  const keepOn = $('#hostlink-keep-on');
  keepOn.hidden = !(st.setting === 'off' && st.running === 'on' && !busy && !forced);
  $('#hostlink-sd').hidden = !sd;
  const pick = $('#hostlink-sd-mode');
  if (sd && !pick.options.length) {
    for (const m of Object.keys(SERDES)) {
      const o = el('option', null, SERDES[m]);
      o.value = m;
      pick.append(o);
    }
  }
  if (sd && !pick.dataset.set) { pick.value = SERDES[ss.setting] ? ss.setting : 'fiber1g'; pick.dataset.set = '1'; }
  pick.disabled = busy;
  $('#hostlink-sd-try').disabled = busy;
  if (trialOf(H) && !tick) openDialog();
}

/* The status verb of host-serdes.sh: the link and where it was read from. It
   forks (diag in 2.5G), so it runs after the page is up and the answer repaints. */
async function loadSerdesStatus() {
  if (!sdOn(H) || ssBusy) return;
  ssBusy = true;
  try {
    const r = await post('action=serdes-status');
    SS = r && r.ok && r.status ? r.status : null;
  } catch (e) { SS = null; } finally { ssBusy = false; }
  renderBlock();
}

/* `known`: the host link already read (the page start has it from
   /api/init), so it is not read twice. */
async function refresh(known) {
  if (known) H = known;
  else try { H = await get('/api/hostlink'); } catch (e) { H = null; }
  renderBanner();
  renderBlock();
  loadSerdesStatus();
  return H;
}

async function post(body) {
  const r = await fetch('/api/hostlink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return r.json();
}

function say(where, cls, text) {
  const out = $(where);
  out.textContent = '';
  if (text) out.append(el('div', cls, text));
}

async function tryMode(mode) {
  const warn = mode === 'off'
    ? 'Turn host port auto-negotiation off?\n\nIf the router port still negotiates, the link drops and this page '
      + 'stops answering. Nothing is stored until you keep it: the stick goes back by itself after two minutes.'
    : 'Turn host port auto-negotiation back on?\n\nIf the router port has it off, the link drops and this page '
      + 'stops answering. Nothing is stored until you keep it: the stick goes back by itself after two minutes.';
  if (!(await ask(warn, { action: mode === 'off' ? 'Turn it off' : 'Turn it on' }))) return;
  say('#hostlink-out', null, '');
  try {
    const res = await post('action=try&mode=' + encodeURIComponent(mode));
    if (!res.ok) { say('#hostlink-out', 'bad', res.error || res.output || 'not started'); return; }
  } catch (e) { say('#hostlink-out', 'bad', String(e.message || e)); return; }
  await refresh();
  openDialog();
}

async function trySerdes() {
  const mode = $('#hostlink-sd-mode').value;
  if (!SERDES[mode]) return;
  if (!(await ask(`Try ${serdesShort(mode)} on the host port?\n\nIf the router port does not run this mode, the link `
    + 'drops and this page stops answering. Nothing is stored until you keep it: the stick goes back by itself '
    + 'after two minutes (120 s).', { action: `Try ${serdesShort(mode)}` }))) return;
  say('#hostlink-sd-out', null, '');
  try {
    const res = await post('action=serdes-try&mode=' + encodeURIComponent(mode));
    if (!res.ok) { say('#hostlink-sd-out', 'bad', res.error || res.output || 'not started'); return; }
  } catch (e) { say('#hostlink-sd-out', 'bad', String(e.message || e)); return; }
  await refresh();
  openDialog();
}

/* The keep-or-revert dialog. A <dialog> where the browser has one, shown
   modal so nothing else is clicked meanwhile. */
function openDialog() {
  const d = $('#hostlink-dialog');
  const t = trialOf(H);
  if (t) kind = t.kind;
  if (typeof d.showModal === 'function' && !d.open) d.showModal(); else d.hidden = false;
  say('#hostlink-dialog-out', null, '');
  let left = trialLeft(H);
  const count = $('#hostlink-count');
  const paint = () => { count.textContent = left === null ? '' : `Reverting in ${left} s.`; };
  paint();
  let since = 0;
  clearInterval(tick);
  tick = setInterval(async () => {
    if (left !== null && left > 0) left -= 1;
    paint();
    since += 1000;
    if (since < POLL_MS || polling) return;
    since = 0;
    polling = true;
    try {
      const h = await get('/api/hostlink');
      H = h;
      const l = trialLeft(h);
      if (l === null) { closeDialog(h); return; }
      left = l;
      say('#hostlink-dialog-out', null, h.link === '1' ? 'The stick answers and reports a host link.' : '');
    } catch (e) {
      say('#hostlink-dialog-out', 'bad', 'No answer from the stick: the link may be down in this mode. '
        + 'It goes back by itself when the countdown ends; this page reconnects then.');
    } finally { polling = false; }
  }, 1000);
}

function closeDialog(h) {
  clearInterval(tick);
  tick = 0;
  const d = $('#hostlink-dialog');
  if (typeof d.close === 'function' && d.open) d.close(); else d.hidden = true;
  const st = (h && h.state) || {};
  const sd = kind === 'serdes';
  const s2 = sd ? sdState(h) : st;
  const name = (m) => (sd ? serdesShort(m) : `auto-negotiation ${modeText(m)}`);
  const what = {
    trial_confirmed: `Kept: ${name(s2.setting)} is stored.`,
    trial_expired: `Not kept in time: back to ${name(s2.running)}. Nothing was stored.`,
    trial_reverted: `Reverted: back to ${name(s2.running)}. Nothing was stored.`,
    trial_failed: `Not applied: back to ${name(s2.running)}. Nothing was stored.`,
  }[s2.event];
  say(sd ? '#hostlink-sd-out' : '#hostlink-out', s2.event === 'trial_confirmed' ? null : 'warn', what || s2.message || '');
  renderBanner();
  renderBlock();
}

async function finish(action) {
  say('#hostlink-dialog-out', null, '');
  try {
    const res = await post('action=' + (kind === 'serdes' ? 'serdes-' : '') + action);
    if (!res.ok) { say('#hostlink-dialog-out', 'bad', res.error || res.output || action + ' failed'); return; }
  } catch (e) { say('#hostlink-dialog-out', 'bad', String(e.message || e)); return; }
  closeDialog(await refresh());
}

/* The two Acknowledge buttons write a record on the stick: one request at a
   time, the button off until the answer and the new state are in. */
const ack = () => once('#hostlink-ack', async () => {
  try {
    const res = await post('action=ack');
    if (!res.ok) { say('#hostlink-out', 'bad', res.error || res.output || 'not acknowledged'); return; }
  } catch (e) { return; }
  await refresh();
});

/* The recreated-store bar answers in itself: it shows on every view, and
   the Host port block may not be on screen. */
const ackReseed = () => once('#reseed-ack', async () => {
  say('#reseed-out', null, '');
  try {
    const res = await post('action=reseed-ack');
    if (!res.ok) { say('#reseed-out', 'bad', res.error || res.output || 'not acknowledged'); return; }
  } catch (e) { say('#reseed-out', 'bad', String(e.message || e)); return; }
  await refresh();
});

function wireHostlink() {
  $('#hostlink-try').onclick = () => tryMode($('#hostlink-try').dataset.mode || 'off');
  $('#hostlink-keep-on').onclick = () => tryMode('on');
  $('#hostlink-sd-try').onclick = trySerdes;
  $('#hostlink-keep').onclick = () => finish('confirm');
  $('#hostlink-revert').onclick = () => finish('revert');
  $('#hostlink-ack').onclick = ack;
  $('#reseed-ack').onclick = ackReseed;
  /* Details: the bar links to System, Access; open the explanation there. */
  $('#safe-details').onclick = () => {
    $('#safemode-help').open = true;
    setTimeout(() => $('#safemode-help').scrollIntoView({ block: 'center' }), 0);
  };
}

export { bannerText, trialLeft, refresh as renderHostlink, wireHostlink, serdesShort, safeModeNow, safeModeDefaultLogin, passwordSavedText, hostlinkNow };
