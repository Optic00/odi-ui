/*
 * The setup wizard: the few settings a new stick needs, asked in order, on top
 * of the page. Simple mode only; everything else stays in Config, and "Skip,
 * I'll use Config" is on every step.
 *
 * It writes through the same code as the Config save bar: withPairs (the LOID
 * pairs), POST /api/config with the identity confirmation, then the omci apply
 * (applyOmci) the keys call for, and vlanRisk for the warning. What it adds is
 * the questions, a validation that mirrors docs/SETTINGS.md of odi-oss (the
 * PLOAM password forms in particular) and the live view of the registration.
 *
 * The marker. /etc/config/confd.setup, a switch file owned by confd (POST
 * /api/switch), says the wizard was completed or skipped, so every browser
 * agrees. No key of the image is involved, and a factory reset removes it. It
 * is written by every way out of the wizard (finish, "Skip", the close button,
 * Escape) and silently by the first status that shows O5. It is left alone
 * while the fibre is down. Only a page unload mid-wizard leaves it unset.
 *
 * Auto-open, exactly: no marker, light on the fibre, and the ONU not in O5.
 * "Light" is what the page already reads: no LOS or LOF asserted and a receive
 * power at or above the bottom of the Status scale (OPTICS.rx.lo). A stick
 * configured before the wizard existed is in O5 (marker written, wizard never
 * shown) or has light and is not (wizard pre-filled with what it holds, and any
 * way out sets the marker).
 *
 * ssh logs in as root with keys only, so the first step can also add one public
 * key through /api/sshkeys, checked by the same sshKeyProblem as System, Access
 * against the keys already installed.
 *
 * Secrets (the PLOAM password, the LOID password, the admin password) are typed
 * into password fields and shown as dots in the review; a field left empty
 * keeps what the stick holds, so an untouched secret is never rewritten.
 */

import { $, el } from './dom.js';
import { S, imageAware, settingOf, vlanRisk, costBadge } from './state.js';
import { valueProblem, passwordProblem, sshKeyProblem, snFromHex } from './validate.js';
import { withPairs, encode, applyOmci } from './save.js';
import { renderAll } from './config.js';
import { OPTICS, STATES, lineFacts } from './status.js';
import { parseOmci } from './omci.js';
import { linkCheck, onuIdOf } from './linkcheck.js';

const MARKER = 'confd.setup';
const SECRETS = ['GPON_PLOAM_PASSWD', 'LOID_PASSWD', 'LOID_PASSWD_OLD'];
const POLL_MS = 3000;
/* About 36 s without O5: long enough for a normal registration, after which
   the hint says what usually holds it back. */
const STALL_POLLS = 12;
const MAX_POLLS = 100;

const W = {
  open: false, auto: false, steps: [], step: '', phase: 'edit', f: {},
  key: '', keys: [],   /* the public key to add, and the lines already installed */
  keysErr: '',         /* why the installed keys could not be listed, when they could not */
  pw: null,            /* { user, pass, again }: the admin password typed in, until it is saved */
  pwChanged: false, timer: 0, polls: 0, autoTried: false, marking: false,
  live: null, out: null, msgs: {}, keysEl: null,
};

/* ------------------------------------------------------------ validation */

const rowOf = (name) => S.SCHEMA.find((r) => r.name === name);
const check = (name, v) => { const r = rowOf(name); return r ? valueProblem(r, v) : null; };

/*
 * The PLOAM password, in the forms the image accepts (odi_gpon_parse_pw, and
 * docs/SETTINGS.md): exactly 20 hex digits are 10 bytes; 0x and 2 to 20 hex
 * digits (whole bytes) are those bytes, zero-padded; 1 to 10 other characters
 * are the text itself, even when each is a hex digit. The store takes only the
 * 20 digits (hex20), so every form is turned into them here, the text and the
 * short hex zero-padded the way the image pads them. Empty means unchanged.
 * Never echoes the input.
 */
const PLOAM_FORMS = 'Use 1 to 10 characters, or 20 hex digits, or 0x and 2 to 20 hex digits.';
function ploamParse(raw) {
  if (raw === '') return { empty: true };
  if (/[^\x20-\x7e]/.test(raw)) return { error: 'Printable ASCII only. ' + PLOAM_FORMS };
  const hex = (h) => ({ hex: (h + '0'.repeat(20)).slice(0, 20).toLowerCase() });
  const isHex = (h) => /^[0-9a-fA-F]*$/.test(h);
  if (raw.length > 2 && /^0[xX]/.test(raw)) {
    const h = raw.slice(2);
    if (isHex(h) && h.length % 2 === 0 && h.length <= 20) return hex(h);
  }
  if (raw.length === 20) {
    return isHex(raw) ? hex(raw)
      : { error: '20 characters are read as hex digits (0-9, a-f), and these are not. ' + PLOAM_FORMS };
  }
  if (raw.length <= 10) {
    return hex([...raw].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
  }
  return { error: PLOAM_FORMS };
}

const vidProblem = (v) => (!/^[1-9]\d{0,3}$/.test(v) || Number(v) > 4094 ? 'A VLAN ID is a whole number from 1 to 4094.' : null);
const priProblem = (v) => (!/^[0-7]$/.test(v) ? 'The priority is a whole number from 0 to 7.' : null);

/* What is wrong with each field of the ISP step and the VLAN step, null when fine. */
function problems(f) {
  const p = {};
  p.sn = f.sn === '' ? 'Enter the serial number your ISP gave you.' : check('GPON_SN', f.sn);
  p.ploam = ploamParse(f.ploam).error || null;
  p.loid = f.loid === '' ? null : check('LOID', f.loid);
  p.loidpw = f.loidpw === '' ? null : check('LOID_PASSWD', f.loidpw);
  if (f.vlan === 'stick') {
    p.vid = vidProblem(f.vid);
    p.pri = priProblem(f.pri);
  }
  return p;
}
const firstProblem = (p) => Object.values(p).find((x) => x) || null;

/* ------------------------------------------------------ choices and keys */

/* The VLAN question as the stored keys answer it (docs/SETTINGS.md, "VLAN
   handling"): the manual tag exists only with VLAN_CFG_TYPE 1 and
   VLAN_MANU_MODE 1; mode 0 under type 1 is transparent (the router tags);
   any other type leaves the OLT's own rule in charge. */
function choiceOf(V) {
  if (V.VLAN_CFG_TYPE !== '1') return 'olt';
  return V.VLAN_MANU_MODE === '1' ? 'stick' : 'router';
}

/* The keys a choice sets, only those that differ from what the stick holds.
   A stored priority above 7 (255 is the factory one) is read as 0 by the
   image, so it counts as 0 here. */
function vlanKeys(f, V) {
  const effPri = V.VLAN_MANU_TAG_PRI !== undefined && Number(V.VLAN_MANU_TAG_PRI) > 7 ? '0' : V.VLAN_MANU_TAG_PRI;
  const want = f.vlan === 'olt' ? (V.VLAN_CFG_TYPE === '1' ? [['VLAN_CFG_TYPE', '0']] : [])
    : f.vlan === 'router' ? [['VLAN_CFG_TYPE', '1'], ['VLAN_MANU_MODE', '0']]
    : [['VLAN_CFG_TYPE', '1'], ['VLAN_MANU_MODE', '1'], ['VLAN_MANU_TAG_VID', f.vid], ['VLAN_MANU_TAG_PRI', f.pri]];
  return want.filter(([k, v]) => (k === 'VLAN_MANU_TAG_PRI' ? effPri : V[k]) !== v);
}

/* The wizard's own form, pre-filled from what the stick holds. */
function initForm(V = S.VALUES) {
  const pri = V.VLAN_MANU_TAG_PRI;
  return {
    sn: V.GPON_SN || '', ploam: '', loid: V.LOID || '', loidpw: '',
    vlan: choiceOf(V), vid: V.VLAN_MANU_TAG_VID || '',
    pri: pri === undefined || pri === '' || Number(pri) > 7 ? '0' : pri,
  };
}

/*
 * What applying would write, and how to show it: { pairs, rows }. pairs are the
 * changed keys (the LOID pairs included, as Config writes them); rows say
 * old -> new per key, the secrets as dots. Empty when nothing the form holds
 * differs from the stick.
 */
function planChanges(f, V = S.VALUES) {
  const own = [];
  if (f.sn !== (V.GPON_SN || '')) own.push(['GPON_SN', f.sn]);
  const pl = ploamParse(f.ploam);
  if (pl.hex && pl.hex !== String(V.GPON_PLOAM_PASSWD || '').toLowerCase()) own.push(['GPON_PLOAM_PASSWD', pl.hex]);
  if (f.loid !== '' && f.loid !== (V.LOID || '')) own.push(['LOID', f.loid]);
  if (f.loidpw !== '' && f.loidpw !== (V.LOID_PASSWD || '')) own.push(['LOID_PASSWD', f.loidpw]);
  own.push(...vlanKeys(f, V));
  const pairs = withPairs(own);
  const rows = pairs.map(([key, neu]) => {
    const secret = SECRETS.includes(key);
    const old = V[key];
    return {
      key, secret, label: (S.META[key] || {}).label || key,
      old: secret ? (old ? 'set' : 'not set') : (old === undefined || old === '' ? 'not set' : old),
      neu: secret ? '•••••• (hidden)' : neu,
      cls: (settingOf(key) || {}).apply || null,
    };
  });
  return { pairs, rows };
}

/* The body of the write: the pairs and, for an identity key, its confirmation. */
function writeBody(pairs) {
  const body = [...pairs];
  if (pairs.some(([k]) => (rowOf(k) || {}).writable === 'identity')) body.push(['_confirm', 'identity']);
  return encode(body);
}

/* ------------------------------------------------------------- the rule */

const markerOn = () => Boolean((S.FW.switches || {})[MARKER]);

/*
 * What a status read means for the wizard: 'mark' (O5: write the marker, show
 * nothing), 'open' (no marker, light, not O5) or 'none'. `facts` is lineFacts of
 * the answer, null when the read failed. No marker support or no firmware read
 * is 'none', so a stick that cannot keep the marker is never nagged, and a
 * fibre with no light writes and shows nothing.
 */
function decide(facts, state = S) {
  const sw = (state.FW || {}).switches;
  if (!facts || !sw || typeof sw[MARKER] !== 'boolean' || sw[MARKER]) return 'none';
  if (!facts.state) return 'none';
  if (facts.state === 'O5') return 'mark';
  const light = !facts.los && facts.rx !== null && facts.rx >= OPTICS.rx.lo;
  return light ? 'open' : 'none';
}

async function wfetch(path, init = {}) {
  return fetch(path, { cache: 'no-store', ...init });
}
const post = (path, body) => wfetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
});

async function setMarker() {
  if (markerOn()) return true;
  try {
    const j = await (await post('/api/switch', new URLSearchParams({ name: MARKER, on: '1' }).toString())).json();
    if (j.ok && j.on) {
      S.FW.switches = { ...(S.FW.switches || {}), [MARKER]: true };
      return true;
    }
  } catch (e) { /* the marker is advisory: the wizard just shows again next time */ }
  return false;
}

/* Called with every status read by app.js. */
async function wizardSeen(facts) {
  if (!imageAware()) return;
  const d = decide(facts);
  if (d === 'mark' && !W.marking) {
    W.marking = true;
    try { await setMarker(); } finally { W.marking = false; }
  } else if (d === 'open' && !W.open && !W.autoTried) {
    W.autoTried = true;
    openWizard(true);
  }
}

/* ------------------------------------------------------------ the dialog */

const isOpen = () => W.open;

function showDialog(on) {
  const d = $('#wizard');
  if (on) {
    if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
  } else if (typeof d.close === 'function') { if (d.open) d.close(); } else d.removeAttribute('open');
}

function openWizard(auto) {
  if (W.open) return;
  clearInterval(W.timer);
  Object.assign(W, {
    open: true, auto: !!auto, phase: 'edit', f: initForm(), pw: null,
    pwChanged: false, polls: 0, live: null, out: null, key: '', keys: [], keysErr: '', keysEl: null,
    steps: ['access', 'isp', 'vlan', 'review'],
  });
  showDialog(true);
  loadKeys();
  go(W.steps[0]);
}

/* Every way out: the marker first. A changed admin password needs no sign-out:
   confd keeps this browser's session and ends every other one. */
async function exitWizard() {
  if (!W.open) return;
  clearInterval(W.timer);
  W.timer = 0;
  await setMarker();
  W.open = false;
  W.pw = null;
  W.live = null;
  showDialog(false);
}

/* Escape: the browser would close the dialog by itself and skip the marker. */
function onCancel(ev) {
  if (ev && ev.preventDefault) ev.preventDefault();
  exitWizard();
}

/* ---------------------------------------------------------------- steps */

const TITLES = {
  access: 'Admin access', isp: 'Your ISP login', vlan: 'VLAN', review: 'Review and apply',
};

function go(id) {
  W.step = id;
  render();
}

function render() {
  const body = $('#wizard-body');
  body.textContent = '';
  const live = W.phase === 'live';
  const i = W.steps.indexOf(W.step);
  $('#wizard-title').textContent = live ? 'Registering with the OLT' : TITLES[W.step];
  $('#wizard-count').textContent = live ? 'Applied' : `Step ${i + 1} of ${W.steps.length}`;
  const list = $('#wizard-steps');
  list.textContent = '';
  W.steps.forEach((s, n) => {
    const li = el('li', n < i || live ? 'done' : null, TITLES[s]);
    if (n === i && !live) li.setAttribute('aria-current', 'step');
    list.append(li);
  });
  W.msgs = {};
  if (live) stepLive(body);
  else ({ access: stepAccess, isp: stepIsp, vlan: stepVlan, review: stepReview }[W.step])(body);
  paint();
  $('#wizard-title').focus();
}

/* A labelled input with its message line. */
function field(id, label, input, hint) {
  const wrap = el('div', 'wiz-field');
  const l = el('label', null, label);
  l.htmlFor = id;
  input.id = id;
  const msg = el('p', 'wiz-msg bad');
  msg.id = id + '-msg';
  msg.setAttribute('role', 'alert');
  input.setAttribute('aria-describedby', id + '-msg' + (hint ? ' ' + id + '-hint' : ''));
  wrap.append(l, input);
  if (hint) { const h = el('p', 'help', hint); h.id = id + '-hint'; wrap.append(h); }
  wrap.append(msg);
  return { wrap, input, msg };
}

function textInput(value, onInput, opts = {}) {
  const i = el('input');
  i.type = opts.secret ? 'password' : 'text';
  i.value = value;
  i.autocomplete = 'off';
  i.spellcheck = false;
  if (opts.placeholder) i.placeholder = opts.placeholder;
  i.oninput = () => { onInput(i.value); paint(); };
  return i;
}

/* A "show what I type" tick for a password field. */
function showTick(input) {
  const l = el('label', 'wiz-show');
  const c = el('input');
  c.type = 'checkbox';
  c.onchange = () => { input.type = c.checked ? 'text' : 'password'; };
  l.append(c, document.createTextNode(' Show what I type'));
  return l;
}

function stepAccess(body) {
  if (S.FW.defaultauth) {
    W.pw = W.pw || { user: 'admin', pass: '', again: '' };
    body.append(el('p', 'lede', 'This page still answers to the built-in admin / admin: anyone who can reach it '
      + 'can change the line settings. Choose a password now. It is saved when you apply the setup; '
      + 'this browser stays signed in.'));
    const u = field('wiz-pw-user', 'Username', textInput(W.pw.user, (v) => { W.pw.user = v.trim(); }));
    const p = field('wiz-pw-pass', 'New password', textInput(W.pw.pass, (v) => { W.pw.pass = v; }, { secret: true }),
      '4 to 128 printable characters.');
    const a = field('wiz-pw-again', 'Repeat the password', textInput(W.pw.again, (v) => { W.pw.again = v; }, { secret: true }));
    W.msgs.pw = a.msg;
    body.append(u.wrap, p.wrap, a.wrap, showTick(p.input));
    const skip = el('button', null, 'Skip the password');
    skip.type = 'button';
    skip.onclick = () => { W.pw = null; go('isp'); };
    body.append(el('p', 'callout warn', 'Without a password the stick keeps the built-in admin / admin. '
      + 'You can set one later under System, Access.'), skip);
  } else {
    body.append(el('p', 'lede', 'This page already has its own password. You can add an SSH key below, or go on.'));
  }
  body.append(el('h3', 'sec', 'SSH key'));
  body.append(el('p', 'help', 'ssh logs in as root with keys only; there is no ssh password. Paste a public key '
    + '(the contents of a .pub file) to add it, or leave this empty.'));
  W.keysEl = el('p', 'hint');
  body.append(W.keysEl);
  paintKeys();
  const k = field('wiz-sshkey', 'Add an SSH key (optional)', textInput(W.key, (v) => { W.key = v.trim(); }));
  k.input.placeholder = 'ssh-ed25519 AAAA\u2026 comment';
  W.msgs.key = k.msg;
  body.append(k.wrap);
}

/* The keys already on the stick, so a legacy stick is not given a duplicate:
   a count and the comments, never a key. */
const keyLabel = (line) => {
  const [type, blob = '', ...c] = String(line).split(/\s+/);
  return type + ' ' + (c.join(' ') || '\u2026' + blob.slice(-8));
};
function paintKeys() {
  if (!W.keysEl) return;
  W.keysEl.textContent = W.keysErr ? `The installed keys could not be listed: ${W.keysErr}.`
    : W.keys.length
      ? `${W.keys.length} key${W.keys.length === 1 ? '' : 's'} installed: ${W.keys.map(keyLabel).join(', ')}.`
      : 'No keys installed yet.';
}
async function loadKeys() {
  W.keysErr = '';
  try {
    const j = await (await wfetch('/api/sshkeys')).json();
    W.keys = (j.keys || []).map((x) => x.line);
    /* A file the daemon will not list, too large or unreadable, is not "no keys". */
    if (!j.keys) W.keysErr = j.error || 'no list came back';
  } catch (e) { W.keys = []; }
  paintKeys();
  if (W.step === 'access') paint();
}

function stepIsp(body) {
  const f = W.f;
  body.append(el('p', 'lede', 'What your ISP gave you for this connection. A field already filled in is what '
    + 'the stick holds now: leave it as it is unless your ISP says otherwise.'));
  /* 16 hex digits, the way a modem label gives the serial, become the stored form in the field. */
  const snIn = textInput(f.sn, (v) => {
    const conv = snFromHex(v);
    f.sn = conv || v.trim();
    if (conv) snIn.value = conv;
  });
  const sn = field('wiz-sn', 'Serial number', snIn,
    'Four letters and eight hex digits, such as ABCD0123ABCD. The same number as 16 hex digits, the modem ID '
    + 'on the label of an ISP modem, is converted. A wrong serial keeps the stick off the line.');
  const pl = field('wiz-ploam', 'PLOAM password (optional)',
    textInput(f.ploam, (v) => { f.ploam = v; },
      { secret: true, placeholder: S.VALUES.GPON_PLOAM_PASSWD ? 'Unchanged: a password is set' : 'None set' }),
    'Many ISPs do not use one. 1 to 10 characters, or 20 hex digits, or 0x and up to 20 hex digits. '
    + 'Leave it empty to keep what is stored.');
  const det = el('details', 'wiz-loid');
  det.open = Boolean(f.loid) || Boolean(f.loidpw);
  det.append(el('summary', null, 'My ISP gave me a LOID'));
  det.append(el('p', 'help', 'Only some ISPs use a LOID and its password. Leave both empty if yours did not.'));
  const li = field('wiz-loid', 'LOID', textInput(f.loid, (v) => { f.loid = v.trim(); }));
  const lp = field('wiz-loidpw', 'LOID password',
    textInput(f.loidpw, (v) => { f.loidpw = v; },
      { secret: true, placeholder: S.VALUES.LOID_PASSWD ? 'Unchanged: a password is set' : 'None set' }));
  det.append(li.wrap, lp.wrap, showTick(lp.input));
  W.msgs = { sn: sn.msg, ploam: pl.msg, loid: li.msg, loidpw: lp.msg };
  body.append(sn.wrap, pl.wrap, showTick(pl.input), det);
}

const VLAN_CHOICES = [
  ['router', 'My router tags the VLAN',
    'The stick adds and removes no tag: the router sends its frames already tagged with the VLAN your ISP uses.'],
  ['stick', 'The stick tags it',
    'The stick tags untagged frames with a VLAN ID and priority, and your router sends them untagged.'],
  ['olt', 'Let the OLT decide',
    'The stick follows the VLAN rule the OLT provisions. Choose this when your ISP did not give you a VLAN.'],
];

function stepVlan(body) {
  const f = W.f;
  body.append(el('p', 'lede', 'Who puts the VLAN tag on your internet traffic? If you do not know, your '
    + 'router settings or your ISP say: a VLAN ID in the router WAN settings means the router tags it.'));
  const set = el('fieldset', 'wiz-choices');
  set.append(el('legend', null, 'Who tags the VLAN'));
  const sub = el('div', 'wiz-stick');
  for (const [id, label, help] of VLAN_CHOICES) {
    const row = el('label', 'wiz-choice');
    const r = el('input');
    r.type = 'radio';
    r.name = 'wiz-vlan';
    r.value = id;
    r.checked = f.vlan === id;
    r.onchange = () => { f.vlan = id; sub.hidden = id !== 'stick'; paint(); };
    row.append(r, el('strong', null, ' ' + label), el('span', 'help', help));
    set.append(row);
  }
  const vid = field('wiz-vid', 'VLAN ID', textInput(f.vid, (v) => { f.vid = v.trim(); }), '1 to 4094.');
  const pri = field('wiz-pri', 'Priority', textInput(f.pri, (v) => { f.pri = v.trim(); }),
    '0 to 7; 0 unless your ISP says otherwise.');
  sub.hidden = f.vlan !== 'stick';
  sub.append(vid.wrap, pri.wrap);
  W.msgs = { vid: vid.msg, pri: pri.msg };
  body.append(set, sub);
}

function stepReview(body) {
  const { pairs, rows } = planChanges(W.f);
  body.append(el('p', 'lede', rows.length || W.pw || W.key
    ? 'These are the changes. Nothing is written until you apply.'
    : 'Nothing differs from what the stick holds, so there is nothing to write.'));
  const list = el('dl', 'wiz-review');
  if (W.pw) {
    list.append(el('dt', null, 'Admin password'),
      el('dd', null, 'built-in → •••••• (hidden), user ' + W.pw.user));
  }
  if (W.key) list.append(el('dt', null, 'SSH key'), el('dd', null, 'add ' + keyLabel(W.key)));
  for (const r of rows) {
    const dt = el('dt', null, r.label + ' ');
    dt.append(el('span', 's-key mono', r.key));
    const dd = el('dd');
    dd.append(el('span', 'wiz-old', r.old), document.createTextNode(' → '), el('strong', null, r.neu));
    if (r.cls) dd.append(document.createTextNode(' '), costBadge(r.cls));
    list.append(dt, dd);
  }
  body.append(list);
  if (pairs.some(([k]) => (settingOf(k) || {}).apply === 'internet')) {
    body.append(el('p', 'callout warn', 'The internet drops while the stick registers again with the OLT: '
      + 'about ten seconds, then however long the OLT takes (typically under a minute). With a wrong serial '
      + 'or PLOAM password it stays down until you correct it.'));
  }
  const risk = vlanRisk(S.VALUES, { ...S.VALUES, ...Object.fromEntries(pairs) });
  if (risk) body.append(el('p', 'callout warn', risk));
  W.out = el('div', 'wiz-out');
  body.append(W.out);
}

/* The live view after the apply: the O1 to O5 ladder, the services and a hint. */
function stepLive(body) {
  const ol = el('ol', 'ladder');
  ol.setAttribute('aria-label', 'ONU state');
  const hint = el('p', 'state-note');
  hint.setAttribute('role', 'status');
  const svc = el('p', 'hint');
  W.live = { ol, hint, svc, facts: null, gem: null };
  body.append(ol, hint, svc);
  const change = el('button', null, 'Change the login');
  change.type = 'button';
  change.onclick = () => {
    clearInterval(W.timer);
    W.phase = 'edit';
    W.live = null;
    go('isp');
  };
  body.append(change);
  if (W.out) body.append(W.out);
  paintLive();
}

/* ---------------------------------------------------- painting and nav */

function paint() {
  const next = $('#wizard-next');
  const live = W.phase === 'live';
  const i = W.steps.indexOf(W.step);
  $('#wizard-back').hidden = live || i <= 0;
  const set = (id, text) => { if (W.msgs[id]) W.msgs[id].textContent = text || ''; };
  let bad = null;
  if (W.step === 'access') {
    const keyBad = W.key ? sshKeyProblem(W.key, W.keys) : null;
    set('key', keyBad);
    let pwBad = null;
    if (S.FW.defaultauth) {
      const pw = W.pw || {};
      const typed = pw.pass || pw.again;
      pwBad = typed ? passwordProblem(pw.user, pw.pass, pw.again) : 'Choose a password, or skip it.';
      set('pw', typed ? pwBad : '');
    }
    bad = pwBad || keyBad;
  } else if (W.step === 'isp' || W.step === 'vlan') {
    const p = problems(W.f);
    for (const k of Object.keys(p)) set(k, p[k]);
    bad = W.step === 'isp' ? firstProblem({ sn: p.sn, ploam: p.ploam, loid: p.loid, loidpw: p.loidpw })
      : firstProblem({ vid: p.vid, pri: p.pri });
  }
  if (live) {
    next.textContent = 'Finish';
    next.disabled = false;
  } else if (W.step === 'review') {
    next.textContent = planChanges(W.f).pairs.length || W.pw || W.key ? 'Apply' : 'Finish';
    next.disabled = W.phase === 'applying';
  } else {
    next.textContent = 'Next';
    next.disabled = Boolean(bad);
  }
}

function back() {
  const i = W.steps.indexOf(W.step);
  if (i > 0) go(W.steps[i - 1]);
}

async function next() {
  if (W.phase === 'live') { await exitWizard(); return; }
  if (W.step !== 'review') { go(W.steps[W.steps.indexOf(W.step) + 1]); return; }
  const { pairs } = planChanges(W.f);
  if (!pairs.length && !W.pw && !W.key) { await exitWizard(); return; }
  await apply(pairs);
}

/*
 * The write, the apply, the password, the marker, then the live view. Values
 * are never printed: a result line names the key and says saved or why not.
 */
async function apply(pairs) {
  const out = W.out;
  out.textContent = '';
  W.phase = 'applying';
  paint();
  try {
    if (pairs.length) {
      const r = await post('/api/config', writeBody(pairs));
      if (r.status === 401) {
        out.append(el('div', 'bad', 'The stick asked for a sign-in: reload this page.'));
        W.phase = 'edit';
        paint();
        return;
      }
      const res = await r.json();
      let failed = 0;
      for (const item of res.results || []) {
        if (!item.ok) failed++;
        out.append(el('div', item.ok ? 'good' : 'bad', item.ok ? `${item.name}: saved` : `${item.name}: ${item.error}`));
      }
      S.VALUES = await (await wfetch('/api/values')).json();
      renderAll();
      if (failed) {
        out.append(el('div', 'bad', 'Some keys were not saved, so nothing was applied. Fix them, or use Config.'));
        W.phase = 'edit';
        paint();
        return;
      }
      if ((res.needs || []).includes('omci')) {
        /* The status lines only: the script output is for the Config page. */
        const box = el('div');
        await applyOmci(box, Boolean(res.interrupts));
        for (const n of box.children) if (n.tagName !== 'pre') out.append(n);
      }
    }
    if (W.key) await addKey(out);
    if (W.pw) await savePassword(out);
    await setMarker();
  } catch (e) {
    out.append(el('div', 'bad', String(e.message || e)));
    W.phase = 'edit';
    paint();
    return;
  }
  W.phase = 'live';
  W.polls = 0;
  render();
  clearInterval(W.timer);
  W.timer = setInterval(pollLive, POLL_MS);
  pollLive();
}

/* One public key, through the route System, Access uses (it refuses a duplicate). */
async function addKey(out) {
  const bad = sshKeyProblem(W.key, W.keys);
  if (bad) { out.append(el('div', 'bad', 'SSH key: ' + bad)); return; }
  const j = await (await post('/api/sshkeys', new URLSearchParams({ key: W.key }).toString())).json();
  if (!j.ok) { out.append(el('div', 'bad', 'SSH key: ' + (j.error || 'refused'))); return; }
  W.keys.push(W.key);
  out.append(el('div', 'good', 'SSH key: added. dropbear reads the file on every login.'));
}

/* The admin password, last. This browser's session survives the change; every
   other browser signed in to the page is signed out by confd. */
async function savePassword(out) {
  const { user, pass, again } = W.pw;
  const bad = passwordProblem(user, pass, again);
  if (bad) { out.append(el('div', 'bad', 'Admin password: ' + bad)); return; }
  const j = await (await post('/api/password', new URLSearchParams({ user, password: pass }).toString())).json();
  if (!j.ok) { out.append(el('div', 'bad', 'Admin password: ' + (j.error || 'refused'))); return; }
  W.pwChanged = true;
  W.pw = { user, pass: '', again: '' };
  out.append(el('div', 'good', 'Admin password: saved. Other browsers signed in to this page are signed out.'));
}

/* ------------------------------------------------------------ live view */

/* The line under the ladder for what the last reads said: the finding of the
   link check (linkcheck.js) for what the wizard reads. Pure. */
function liveHint(facts, polls, more) {
  if (!facts) return { cls: 'warn', text: 'No answer from the stick yet.' };
  const m = more || {};
  /* In O5 the stall counts from reaching it: the provisioning starts there. */
  const stall = facts.state === 'O5' && m.o5Polls !== undefined ? m.o5Polls : polls;
  const r = linkCheck({ ...facts, stalled: stall >= STALL_POLLS, onuId: m.onuId, gem: m.gem });
  if (r.finding.stage === 'registered' && r.finding.cls === 'warn') {
    return { cls: 'warn', text: (facts.state ? (STATES[facts.state] || facts.state) + '. ' : '') + r.finding.text };
  }
  return { cls: r.finding.cls, text: r.finding.text };
}

function paintLive() {
  const L = W.live;
  if (!L) return;
  const n = L.facts && L.facts.state ? Number(L.facts.state.slice(1)) : 0;
  L.ol.textContent = '';
  for (let i = 1; i <= 5; i++) {
    const li = el('li', null, 'O' + i);
    li.title = STATES['O' + i];
    if (i === n) { li.setAttribute('aria-current', 'step'); li.classList.add('here'); }
    if (i < n) li.classList.add('done');
    L.ol.append(li);
  }
  const h = liveHint(L.facts, W.polls, { onuId: L.onuId, gem: L.gem === null ? undefined : L.gem, o5Polls: L.o5Polls || 0 });
  L.hint.className = 'state-note ' + h.cls;
  L.hint.textContent = h.text;
  L.svc.textContent = L.gem === null ? '' : L.gem
    ? `Services: the OLT provisioned ${L.gem} GEM port${L.gem === 1 ? '' : 's'}.`
    : 'Services: the OLT has not provisioned any yet.';
}

async function pollLive() {
  const L = W.live;
  if (!L || !W.open) { clearInterval(W.timer); return; }
  W.polls++;
  try {
    const j = await (await wfetch('/api/status')).json();
    L.facts = j.error ? null : lineFacts(j.raw);
    L.onuId = j.error ? undefined : onuIdOf(j.onu_id);
    L.o5Polls = L.facts && L.facts.state === 'O5' ? (L.o5Polls || 0) + 1 : 0;
    if (L.facts && L.facts.state === 'O5') {
      const m = await (await wfetch('/api/omci?cmd=me&me=268')).json();
      L.gem = m.ok === false ? null : parseOmci(m.raw || '').instances.length;
    }
  } catch (e) { L.facts = null; }
  if (W.live !== L) return;
  paintLive();
  if ((L.facts && L.facts.state === 'O5' && L.gem) || W.polls >= MAX_POLLS) clearInterval(W.timer);
}

/* ---------------------------------------------------------------- wiring */

/* The Setup entry in the header: only on an image that says what its keys cost. */
function renderSetupEntry() {
  $('#setup-open').hidden = !imageAware();
}

function wireWizard() {
  $('#setup-open').onclick = () => openWizard(false);
  $('#wizard-next').onclick = next;
  $('#wizard-back').onclick = back;
  $('#wizard-skip').onclick = () => exitWizard();
  $('#wizard-x').onclick = () => exitWizard();
  $('#wizard').addEventListener('cancel', onCancel);
}

export {
  wireWizard, wizardSeen, renderSetupEntry, openWizard, exitWizard, onCancel, isOpen, decide, planChanges, writeBody,
  ploamParse, vidProblem, priProblem, problems, vlanKeys, choiceOf, initForm, liveHint, markerOn, back, next,
  MARKER, W,
};
