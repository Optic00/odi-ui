/*
 * Entry point: wire the tabs, load everything the page renders from, and start
 * the status poll.
 *
 * The UI renders from /api/schema, so a new config key appears without touching
 * any of this.
 */

import { $, el, fail, get, wireTheme, wireHelp } from './dom.js';
import { S, EDITS } from './state.js';
import { renderStatus, renderLinkCheck, sections, lineFacts } from './status.js';
import { parsePorts } from './flow.js';
import { linkCheck, trackLink, omciState } from './linkcheck.js';
import { parseOmci } from './omci.js';
import { renderAll } from './config.js';
import { save, refreshSaveBar, renderIdentitySwitch } from './save.js';
import { renderFirmware, wireFirmware, renderTrial } from './firmware.js';
import { renderServices } from './services.js';
import { renderMeBrowser } from './mebrowser.js';
import { renderPhone, wirePhone, hideSecrets } from './phone.js';
import { wireRestore, saveBackup } from './restore.js';
import { renderL2 } from './l2.js';
import { renderTools } from './tools.js';
import { renderHostlink, wireHostlink } from './hostlink.js';
import { renderNetaddr, wireNetaddr } from './netaddr.js';
import { checkForUpdate, wireUpdates, renderUpdateSwitch } from './updates.js';
import { passwordProblem, sshKeyProblem } from './validate.js';
import { wireWizard, wizardSeen, renderSetupEntry } from './wizard.js';

/*
 * Four sections, each with subtabs, and the location hash naming the pair:
 * #config/vlan, #system/logs. A bare #config lands on the first subtab.
 *
 * Both levels are ARIA tablists: arrow keys move between tabs and activate
 * them, Home and End jump to the ends, and only the selected tab is in the
 * tab order, so Tab goes from the tab row straight into its panel.
 */
const TABS = ['status', 'config', 'omci', 'system'];
/* Old tab names, so a bookmark from before the regrouping still lands. */
const OLD = {
  advanced: 'config/stock', services: 'omci/services', mib: 'omci/mib',
  tools: 'system/logs', admin: 'system/access', firmware: 'system/firmware',
};

/* What a view needs the first time it is shown. The OMCI and firmware views
   read the device, so they load on sight rather than at boot: seven forks of
   ~35 ms each is not something to spend before the status page has painted. */
const ON_SHOW = {
  'omci/services': () => renderServices(),
  'omci/mib': () => renderMeBrowser(),
  'omci/phone': () => renderPhone(),
  'system/firmware': () => { renderFirmware(); renderUpdateSwitch(); },
  'system/access': () => renderSshKeys(),
  'system/logs': () => renderTools(),
};

function subsOf(tab) {
  return [...document.querySelectorAll(`#p-${tab} .subtabs [role=tab]`)].filter((b) => !b.hidden);
}

function select(list, on) {
  for (const b of list) {
    const me = b === on;
    b.setAttribute('aria-selected', me ? 'true' : 'false');
    b.tabIndex = me ? 0 : -1;
    const panel = document.getElementById(b.getAttribute('aria-controls'));
    if (panel) panel.hidden = !me;
  }
}

function route() {
  let h = location.hash.replace(/^#/, '');
  if (OLD[h]) h = OLD[h];
  let [tab, sub] = h.split('/');
  if (!TABS.includes(tab)) tab = 'status';
  const top = [...document.querySelectorAll('.tabs [role=tab]')];
  select(top, top.find((b) => b.dataset.tab === tab));

  const subs = subsOf(tab);
  let view = tab;
  if (subs.length) {
    const on = subs.find((b) => b.dataset.sub === sub) || subs[0];
    select(subs, on);
    view = tab + '/' + on.dataset.sub;
  }
  /* The default-password banner is loud on the two views where it is about
     what you are looking at, and a small chip in the header everywhere else. */
  VIEW = view;
  showAuth();
  /* Full help opens the field help, and only the Config tab has fields. */
  $('#helptoggle').hidden = tab !== 'config';
  /* The phone secrets live in memory only while that view is open. */
  if (view !== 'omci/phone') hideSecrets();
  if (ON_SHOW[view]) ON_SHOW[view]();
}

let VIEW = 'status';
function showAuth() {
  const loud = VIEW === 'status' || VIEW === 'system/access';
  const on = !!(S.FW && S.FW.defaultauth);
  $('#defaultauth').hidden = !on || !loud;
  $('#authchip').hidden = !on || loud;
}

function go(view) {
  if (location.hash === '#' + view) route(); else location.hash = view;
}

/* Arrow keys, Home and End, on either level. */
function wireTablist(list, key) {
  list.addEventListener('keydown', (e) => {
    const tabs = [...list.querySelectorAll('[role=tab]')].filter((b) => !b.hidden);
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const j = e.key === 'ArrowRight' ? (i + 1) % tabs.length
      : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    tabs[j].focus();
    tabs[j].click();
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[role=tab]');
    if (b) key(b);
  });
}

wireTablist($('.tabs'), (b) => go(b.dataset.tab));
for (const list of document.querySelectorAll('.subtabs')) {
  const tab = list.closest('.panel').id.slice(2);
  wireTablist(list, (b) => go(tab + '/' + b.dataset.sub));
}
window.addEventListener('hashchange', route);
route();

$('#filter').oninput = () => renderAll();
$('#save').onclick = save;
$('#services-reload').onclick = () => renderServices(true);
$('#pw-save').onclick = savePassword;
$('#sshkey-add').onclick = addSshKey;
$('#reset-go').onclick = resetConfig;
wireRestore();
wirePhone();
wireTheme();
wireHelp();
wireFirmware();
wireHostlink();
wireNetaddr();
wireWizard();
wireUpdates();
/* On demand, not on the poll: it is another diag fork and most visits to the
   status page do not need it. Both firmwares answer it: the stock diag, and
   odi-oss diag from its own L2 table readback, under the same command. */
$('#l2-load').onclick = renderL2;
$('#gopassword').onclick = () => { go('system/access'); $('#pw-pass').focus(); };
$('#discard').onclick = () => { EDITS.clear(); renderAll(); refreshSaveBar(); $('#saveout').textContent = ''; };

/*
 * Say so while the built-in credential is in force. The fallback exists so a
 * freshly flashed stick is reachable at all; leaving it in place is a
 * different decision, and one the operator has to be able to see they are
 * making.
 */
async function checkAuth(known) {
  try {
    /* At start the firmware came with /api/init; after a password change it
       is read again. */
    S.FW = known || await get('/api/firmware');
  } catch (e) { /* the banner is advisory; a failed read must not blank the page */ }
  showAuth();
  renderTrial();
}

/*
 * Change the credential this page authenticates with, creating the file if it
 * is not there. That last part is the point: the state this fixes is the state
 * of every factory-reset stick, and a credential that can only be set from a
 * shell is one that stays at its default.
 */
async function savePassword() {
  const out = $('#pw-out');
  const user = $('#pw-user').value.trim();
  const pass = $('#pw-pass').value;
  const again = $('#pw-pass2').value;

  out.textContent = '';
  /* The daemon checks the same rules, but a typo in a password with no repeat
     field is the one mistake it cannot catch: the credential is saved as typed
     and the next request answers 401. */
  const bad = passwordProblem(user, pass, again);
  if (bad) { out.append(el('div', 'bad', bad)); return; }
  try {
    const r = await fetch('/api/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user, password: pass }).toString(),
    });
    const j = await r.json();
    if (!j.ok) { out.append(el('div', 'bad', j.error || 'refused')); return; }
    out.append(el('div', 'good', 'Saved to /etc/config/confd.auth.'));
    /* This browser stays signed in; confd has signed out every other one. */
    out.append(el('div', null,
      'You stay signed in here. Any other browser signed in to this page is signed out, '
      + 'and signs in again as ' + user + '.'));
    $('#pw-pass').value = '';
    $('#pw-pass2').value = '';
    await checkAuth();
  } catch (e) { out.append(el('div', 'bad', String(e.message || e))); }
}

/*
 * SSH public keys for the device login. The list is the file as it is, so a
 * key added over ssh by hand shows up here too. A delete names the line number
 * the server reported and the line as it was listed, so that a list that is out
 * of date (a second tab, a change over ssh) removes nothing, where the number
 * alone would have removed whatever key holds that line now.
 */
/* The lines on the stick as last listed, for the duplicate check and for the
   warning before the last one is removed. */
let SSH_LINES = [];

async function renderSshKeys() {
  const box = $('#sshkeys');
  box.textContent = '';
  try {
    const j = await get('/api/sshkeys');
    SSH_LINES = j.keys.map((k) => k.line);
    if (!j.keys.length) { box.append(el('p', 'hint', 'No keys yet: SSH accepts the root password only.')); return; }
    const t = el('ul', 'keylist');
    for (const k of j.keys) {
      const li = el('li');
      const parts = k.line.split(/\s+/);
      const blob = parts[1] || '';
      li.append(el('span', 'k-type', parts[0] || ''));
      li.append(el('span', 'k-blob mono', blob.length > 24 ? blob.slice(0, 12) + '\u2026' + blob.slice(-8) : blob));
      li.append(el('span', 'k-comment', parts.slice(2).join(' ')));
      const del = el('button', 'danger-quiet', 'Remove');
      del.type = 'button';
      del.setAttribute('aria-label', 'Remove key ' + (parts.slice(2).join(' ') || blob.slice(-8)));
      del.onclick = () => delSshKey(k.i, k.line);
      li.append(del);
      t.append(li);
    }
    box.append(t);
  } catch (e) { box.append(el('div', 'bad', String(e.message || e))); }
}

async function addSshKey() {
  const out = $('#sshkey-out');
  const key = $('#sshkey-new').value.trim();
  out.textContent = '';
  const bad = sshKeyProblem(key, SSH_LINES);
  if (bad) { out.append(el('div', 'bad', bad)); return; }
  try {
    const r = await fetch('/api/sshkeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key }).toString(),
    });
    const j = await r.json();
    if (!j.ok) { out.append(el('div', 'bad', j.error || 'refused')); return; }
    $('#sshkey-new').value = '';
    out.append(el('div', 'good', 'Added. dropbear reads the file on every login; nothing to restart.'));
    await renderSshKeys();
  } catch (e) { out.append(el('div', 'bad', String(e.message || e))); }
}

export async function delSshKey(i, line) {
  const out = $('#sshkey-out');
  out.textContent = '';
  /* The only way into a keys-only stick, and a removal that cannot be undone
     from here: the key has to be pasted again. */
  if (!confirm('Remove this key?\n\n'
      + (SSH_LINES.length <= 1
        ? 'It is the last one: on an image whose root password is locked, nothing else lets you log in over ssh. '
        : 'Whoever holds its private half can no longer log in. ')
      + 'To get it back you have to paste it again.\n\nContinue?')) return;
  try {
    const r = await fetch('/api/sshkeys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ delete: String(i), line }).toString(),
    });
    const j = await r.json();
    /* Refused or not, the list is read again: a refusal is most often a list
       that no longer matches the file. */
    if (!j.ok) out.append(el('div', 'bad', j.error || 'refused'));
    await renderSshKeys();
  } catch (e) { out.append(el('div', 'bad', String(e.message || e))); }
}

/*
 * Reset the service config, backup first.
 *
 * The backup is fetched as a blob and handed to the browser BEFORE the
 * destructive call, and the reset does not run if that fails. A link the
 * operator is told to click first is not a precondition -- it is a hope, and
 * the whole reason this device has bricked sticks in the field is resets done
 * without one.
 */
async function resetConfig() {
  const out = $('#reset-out');
  const btn = $('#reset-go');

  out.textContent = '';
  if (!confirm('Reset the service configuration to the image defaults?\n\n'
      + 'The keys in /etc/config_default.xml go back to their defaults: the four '
      + 'LOID keys are emptied, and DEVICE_TYPE, DUAL_MGMT_MODE and the three '
      + 'OMCI_CUSTOM masks (read only by the stock firmware) are reset. The '
      + 'management IP, the VLAN, the PLOAM password, the serial number and the '
      + 'MAC keys are NOT touched.\n\nA backup downloads first.')) return;

  btn.disabled = true;
  try {
    /* The same backup as the Backup block: encrypted when a password is given. */
    const pw = $('#reset-pass').value;

    if (pw !== $('#reset-pass2').value) throw new Error('the two backup passwords differ; nothing was reset');
    out.append(el('div', null, 'Downloading a backup…'));
    const done = await saveBackup(pw);
    out.append(el('div', 'good', `Backup saved (${done.size} bytes${done.encrypted ? ', encrypted' : ', not encrypted'}).`));

    const p = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'store=cs&_confirm=reset',
    });
    const j = await p.json();
    if (j.output) out.append(el('pre', null, j.output.trim()));
    if (!j.ok) { out.append(el('div', 'bad', j.error || 'the reset reported a failure')); return; }
    S.VALUES = await get('/api/values');
    renderAll();
    /* Of the reset keys, only the LOID ones are read here, by omcid, and
       they apply the way every omcid key does. */
    out.append(el('div', 'warn', 'Written. The LOID keys take effect when OMCI is '
      + 'applied (Apply now, on the Config tab save bar) or at the next reboot; the '
      + 'rest are read only by the stock firmware.'));
  } catch (e) {
    out.append(el('div', 'bad', String(e.message || e)));
    out.append(el('div', null, 'Nothing was reset.'));
  } finally {
    btn.disabled = false;
  }
}

/*
 * The link check's inputs beyond /api/status: what omcid says of itself and
 * how many GEM ports the MIB holds. Two omcicli runs, so at most once a
 * minute and only where they answer: the odi-oss image (its /api/status has
 * onu_id) in O5, the only state the stages that need them are checked in.
 */
const LINK = { T: null, omci: null, gem: undefined, at: 0 };
const LINK_OMCI_MS = 60000;

async function linkOmci(st, facts) {
  if (st.onu_id === undefined || !facts || facts.state !== 'O5') {
    /* LINK.at is kept: a line that flaps in and out of O5 still costs
       the two omcicli runs at most once a minute. */
    LINK.omci = null;
    LINK.gem = undefined;
    return;
  }
  if (Date.now() - LINK.at < LINK_OMCI_MS) return;
  LINK.at = Date.now();
  try {
    const s = await get('/api/omci?cmd=state');
    LINK.omci = s.error ? null : omciState(s.raw);
    const m = await get('/api/omci?cmd=me&me=268');
    LINK.gem = m.ok === false || m.error ? undefined : parseOmci(m.raw || '').instances.length;
  } catch (e) {
    LINK.omci = null;
    LINK.gem = undefined;
  }
}

async function linkStatus(st) {
  const facts = lineFacts(st.raw);
  await linkOmci(st, facts);
  const ports = parsePorts(sections(st.raw)['mib dump counter port all'] || '');
  const { T, f } = trackLink(LINK.T, { facts, st, ports, omci: LINK.omci, gem: LINK.gem });
  LINK.T = T;
  renderLinkCheck(f ? linkCheck(f) : null);
}

async function refresh() {
  if (S.REBOOTING) return;
  try {
    const st = await get('/api/status');
    if (st.error) throw new Error(st.error);
    renderStatus(st.raw, st.chip_temp, st);
    await linkStatus(st);
    /* The setup wizard decides from the same read: open, mark, or leave alone. */
    await wizardSeen(lineFacts(st.raw));
  } catch (e) { fail(e); }
}

/*
 * A 401 from the stick means this browser's session ended: signed out in
 * another tab, confd restarted, or the session ran out. Every fetch the page
 * makes goes through here, so whichever one finds out first takes the page to
 * the sign-in page, keeping the view in the hash. Only the stick's own
 * answers count: a 401 from GitHub (the release check) is not ours.
 */
export function watchSession(g = globalThis) {
  const inner = g.fetch;
  if (typeof inner !== 'function' || inner.watched) return;
  const wrapped = async (...args) => {
    const r = await inner.apply(g, args);
    const loc = g.location;
    if (r && r.status === 401 && loc && typeof r.url === 'string'
        && (r.url.startsWith(loc.origin + '/') || r.url.startsWith('/'))) {
      loc.href = '/login' + (loc.hash || '');
    }
    return r;
  };
  wrapped.watched = true;
  g.fetch = wrapped;
}

/* The host link /api/init brought, for the first banner. */
let INIT_HOSTLINK = null;

(async function init() {
  watchSession();
  try {
    /* Two requests, not nine: /api/static is the image files (tagged, so
       usually a 304) and /api/init what the device holds. confd answers one
       request at a time, so each one saved is a wait saved. */
    const [st, init] = await Promise.all([get('/api/static'), get('/api/init')]);
    S.SCHEMA = st.schema;
    S.DEFAULTS = st.defaults;
    S.VALUES = init.values;
    S.FW = init.firmware || {};
    INIT_HOSTLINK = init.hostlink || null;
    for (const m of st.meta) S.META[m.name] = m;
    for (const r of st.settings) S.SETTINGS[r.name] = r;
    for (const c of st.consumers) S.CONS[c.name] = c;
    for (const b of st.baseline) S.BASELINE[b.name] = b.value;
    for (const f of st.features) (S.FEATURES[f.mask] ||= []).push(f);
    renderAll();
    renderIdentitySwitch();
  } catch (e) { fail(e); }
  await checkAuth(S.FW);
  renderSetupEntry();
  /* The host-link banner, from what /api/init already brought. */
  await renderHostlink(INIT_HOSTLINK);
  /* The address trial: whether the image has it (Save and Restore then go through it) and a trial that
     is already running, which raises its dialog. Before the form is used. */
  await renderNetaddr();
  /* Not awaited: a browser that cannot reach GitHub must not delay the page. */
  checkForUpdate();
  await refresh();
  /* Rates (switch, Forwarding, CPU) are the difference between two polls, so
     the first poll only shows "measuring". One extra poll 3 s later gives
     them a figure then instead of 15 s after the page opened. */
  setTimeout(refresh, 3000);
  /* A scrape is three forks of ~35 ms each on a ~300 BogoMIPS core, so this is
     deliberately unhurried. */
  setInterval(refresh, 15000);
})();
