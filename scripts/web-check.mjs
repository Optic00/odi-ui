/*
 * Load the whole module graph and drive it against fixture data.
 *
 * Splitting app.js into modules moved a class of mistake from "obvious" to
 * "silent": a missing export, an import that resolves to undefined, or an
 * import cycle that leaves a binding uninitialised produces a blank page and a
 * console error nobody sees, because the only way to run this page is to flash
 * a stick and open a browser.
 *
 * So: a DOM stub thin enough to be honest about what it is, the repo's own
 * schema files as fixtures, and an assertion that the page renders rows. It
 * does not check layout or CSS -- it checks that the pieces still fit.
 *
 *   node scripts/web-check.mjs        (via make check)
 */
import { readFileSync } from 'fs';
import { fileURLToPath, URL as NodeURL } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* --- a DOM, to the depth this page actually uses ------------------------- */
class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attrs = {};
    this.dataset = {}; this.options = [];
    this.style = { setProperty: (k, v) => { this.style[k] = v; } };
    this._text = ''; this.hidden = false; this.disabled = false;
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
  }
  /* className and classList are the same thing in a real DOM, and el() in
     dom.js sets className directly. Keeping them separate here meant
     classList.contains() answered false for every class the page assigns,
     which silently passed any test that only checked the happy path. */
  get className() { return [...this.classList._s].join(' '); }
  set className(v) {
    this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...n) {
    for (const x of n) {
      this.children.push(x);
      if (this.tagName === 'select' && x.tagName === 'option') this.options.push(x);
    }
  }
  appendChild(n) { this.append(n); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener() {}
  focus() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get value() { return this._value ?? ''; }
  set value(v) { this._value = v; }
}

const byId = new Map();
const doc = {
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t), children: [] }),
  querySelector: (sel) => {
    if (!byId.has(sel)) byId.set(sel, new El('div'));
    return byId.get(sel);
  },
  querySelectorAll: () => [],
  addEventListener: () => {},
  dispatchEvent: () => true,
};
doc.documentElement = { dataset: {} };
globalThis.document = doc;
globalThis.Event = class { constructor(t) { this.type = t; } };
globalThis.CustomEvent = globalThis.Event;
globalThis.location = { hostname: 'stick.example', href: '/', hash: '' };
globalThis.window = { addEventListener: () => {} };
globalThis.setInterval = () => 0;
globalThis.confirm = () => false;   /* the reset flow asks; nothing here clicks it */
/* The real URL class (updates.js parses links with it), plus the two blob stubs. */
globalThis.URL = Object.assign(NodeURL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });

/* --- fixtures: the repo's own data, shaped as the API returns it --------- */
function tsv(name, cols) {
  const out = [];
  for (const line of readFileSync(join(root, 'schema', name), 'utf8').split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('name\t')) continue;
    const f = line.split('\t');
    out.push(Object.fromEntries(cols.map((c, i) => [c, f[i] ?? ''])));
  }
  return out;
}
const SCHEMA = tsv('keys.tsv', ['name', 'store', 'address', 'section', 'type', 'apply', 'writable', 'common']);
const META = tsv('meta.tsv', ['name', 'label', 'help', 'options', 'depends', 'range']);
const CONS = tsv('consumers.tsv', ['name', 'apply', 'readers']);
const FEAT = tsv('features.tsv', ['mask', 'bit', 'feature', 'module']);
const SETT = tsv('settings.tsv', ['name', 'apply', 'action', 'pair', 'reader', 'note', 'unset']);
const VALUES = Object.fromEntries(SCHEMA.map((r) => [r.name, '1']));

const API = {
  '/api/schema': SCHEMA, '/api/meta': META, '/api/consumers': CONS,
  '/api/values': VALUES, '/api/defaults': {}, '/api/baseline': [], '/api/features': FEAT,
  '/api/settings': SETT,
  '/api/hostlink': { supported: true, state: { setting: 'on', running: 'on', phase: 'steady', fallback: '0' },
                     safemode: null, link: '1', uptime: '300' },
  '/api/netaddr': { supported: false, state: {}, via: '192.168.0.1', peer: '192.168.0.50', uptime: '300' },
  '/api/ntp': { now: 1760773930, ntp: null },
  '/api/status': { raw: 'RTK.0> gpon get onu-state\n  Operation State(O5)\n' },
  '/api/firmware': {
    running: 'ODI-260910-6861b53', confd: 'test', mem: '26 MB', build: {},
    defaultauth: false, switches: { 'omci-identity.on': false }, lanip_override: false,
    env: { sw_active: '0', sw_commit: '0', sw_tryactive: '2',
           sw_version0: 'ODI-260910-6861b53', sw_version1: 'V1.0-220923' },
  },
};

/*
 * The OMCI fixtures are REAL device output, captured from sticks running the
 * same V1.0-220923 base ours do -- see scripts/fixtures/omci/README.md. That
 * matters more here than anywhere else in this file: the ME parser exists
 * purely to cope with a format that is inconsistent between tables, and a
 * fixture written to match the parser would test nothing.
 */
const fx = (f) => readFileSync(join(root, 'scripts/fixtures/omci', f), 'utf8');
const OMCI = {
  84: fx('84-VlanTagFilterData.txt'),
  171: fx('171-ExtVlanTagOperCfgData.txt'),
  7: fx('7-SWImage.txt'),
  131: fx('131-OltG.txt'),
  11: fx('11-EthUni-isp1.txt'),
  329: fx('329-VEIP-isp1.txt'),
  47: fx('47-MacBriPortCfgData-isp1.txt'),
};
const OMCI_ISP2_47 = fx('47-MacBriPortCfgData-isp2.txt');
const OMCI_ISP1_171 = fx('171-isp1.txt');

/*
 * ME 7 has no capture yet. The FRAME below is verified -- it is the one the two
 * real fixtures use -- but the attribute names are assumed, so this exercises
 * the comparison logic and NOT the claim that this firmware calls the attribute
 * "Version". scripts/capture-omci.sh settles that; until it has run, this is
 * labelled for what it is rather than filed beside the real captures.
 */
const ME7_SHAPED = [
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 'SWImage',
  'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  '=================================',
  'EntityId: 0x0000', 'Version: V1.0-220923', 'IsActive: 1', 'IsCommitted: 1',
  '=================================', '',
].join('\n');
globalThis.fetch = async (path) => {
  const [key, qs] = String(path).split('?');
  if (key === '/api/omci') {
    const p = new URLSearchParams(qs || '');
    const raw = p.get('cmd') === 'me' ? (OMCI[p.get('me')] ?? '') : '';
    return { ok: true, status: 200, json: async () => ({ raw, ok: true, truncated: false }) };
  }
  /* The two start-up bundles, made of the single routes so a check that
     swaps one of those sees it here too. */
  if (key === '/api/static') {
    const body = { defaults: API['/api/defaults'] };
    for (const k of ['schema', 'meta', 'consumers', 'settings', 'features', 'baseline']) body[k] = API['/api/' + k];
    return { ok: true, status: 200, json: async () => body };
  }
  if (key === '/api/init') {
    return { ok: true, status: 200, json: async () => ({
      values: API['/api/values'], firmware: API['/api/firmware'], hostlink: API['/api/hostlink'] }) };
  }
  if (!(key in API)) throw new Error('unexpected fetch: ' + key);
  return { ok: true, status: 200, json: async () => API[key] };
};

const textOf = (n) => (n.nodeType === 3 ? n.textContent
  : (n._text || '') + (n.children || []).map(textOf).join(''));

/* --- load the graph and render ------------------------------------------ */
let failed = 0;
const ok = (cond, what) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!cond) failed++;
};

const mods = ['dom', 'state', 'status', 'flow', 'overview', 'validate', 'expert', 'config', 'save', 'firmware',
              'omci', 'services', 'mebrowser', 'phone', 'restore', 'crypto', 'l2', 'tools', 'hostlink', 'netaddr', 'updates', 'wizard'];
for (const m of mods) {
  const mod = await import(join(root, 'web', `${m}.js`));
  ok(Object.keys(mod).length > 0, `${m}.js loads and exports something`);
}

const { S } = await import(join(root, 'web', 'state.js'));
const { renderConfig, renderAll } = await import(join(root, 'web', 'config.js'));
const { valueProblem, fixedMeParse, fixedMeSerialise, fixedMeRowProblems } = await import(join(root, 'web', 'validate.js'));
const { renderFixedMeEditor } = await import(join(root, 'web', 'expert.js'));
const { renderStatus } = await import(join(root, 'web', 'status.js'));

S.SCHEMA = SCHEMA;
S.VALUES = VALUES;
for (const m of META) S.META[m.name] = m;
for (const c of CONS) S.CONS[c.name] = c;
for (const f of FEAT) (S.FEATURES[f.mask] ||= []).push(f);

renderConfig('#sections', S.SCHEMA, '', true);
ok(doc.querySelector('#sections').children.length > 0, 'the stock-keys list renders rows');
renderConfig('#set-line', S.SCHEMA.filter((r) => r.common === 'yes'), '');
ok(doc.querySelector('#set-line').children.length > 0, 'a Config subtab renders rows');

const vlan = SCHEMA.find((r) => r.name === 'VLAN_MANU_TAG_VID');
ok(valueProblem(vlan, '99999') !== null, 'an out-of-range VLAN is rejected');
ok(valueProblem(vlan, '100') === null, 'an in-range VLAN is accepted');
const ip = SCHEMA.find((r) => r.name === 'LAN_IP_ADDR');
ok(valueProblem(ip, '1.2.3.999') !== null, 'a bad octet is rejected');

/* The shared table of what every input accepts and refuses: scripts/smoke.sh
   posts the same rows to the daemon, so a rule cannot change in one layer. */
{
  const V = await import(join(root, 'web', 'validate.js'));
  const rows = readFileSync(join(root, 'scripts', 'fixtures', 'validation-vectors.tsv'), 'utf8')
    .split('\n').filter((l) => l && !l[0].match(/[#]/)).map((l) => l.split('\t'))
    .filter((r) => r[0] !== 'kind');
  const dec = (x) => decodeURIComponent(x.replace(/\+/g, ' '));
  const lines = [];
  let seen = 0;
  /* The gateway of a route is judged against the management addresses, so the
     table is run against the stock ones, which scripts/smoke.sh stores before
     it posts the same rows. */
  const heldLan = { ...S.VALUES };
  Object.assign(S.VALUES, { LAN_IP_ADDR: '192.168.1.1', LAN_SUBNET: '255.255.255.0', LAN_ENABLE_IP2: '0',
    LAN_IP_ADDR2: '', LAN_SUBNET2: '255.255.255.0', LAN_ROUTES: '' });
  for (const [kind, name, value, expect] of rows) {
    const raw = dec(value);
    let bad;
    if (kind === 'key') {
      const row = SCHEMA.find((r) => r.name === name);
      bad = row ? V.valueProblem(row, raw) : 'no such key in the schema';
    } else if (kind === 'password') bad = V.passwordProblem(dec(name), raw);
    else if (kind === 'sshkey') {
      bad = V.sshKeyProblem(raw, lines);
      if (!bad) lines.push(raw);
    } else if (kind === 'ping') bad = V.pingProblem(raw);
    else if (kind === 'me') bad = V.meProblem(raw);
    else if (kind === 'entity') bad = V.entityProblem(raw);
    else bad = 'unknown kind ' + kind;
    seen++;
    if ((bad === null) !== (expect === 'ok')) {
      ok(false, `vector ${kind} ${name} ${value.slice(0, 50)}: the page says ${bad === null ? 'ok' : bad}, the table says ${expect}`);
    }
  }
  Object.assign(S.VALUES, heldLan);
  ok(seen > 150, `${seen} validation vectors agree with the page`);

  /* Rules that read another key: the page judges them from the pending edits,
     then the stored values, as the daemon does from the request, then the store. */
  const { EDITS } = await import(join(root, 'web', 'state.js'));
  const ip2 = SCHEMA.find((r) => r.name === 'LAN_IP_ADDR2');
  const en2 = SCHEMA.find((r) => r.name === 'LAN_ENABLE_IP2');
  const was = { ...S.VALUES };
  S.VALUES.LAN_IP_ADDR = '192.168.1.1';
  S.VALUES.LAN_ENABLE_IP2 = '0';
  ok(V.valueProblem(ip2, '192.168.1.1') === null, 'the second address may equal the first while it is off');
  EDITS.set('LAN_ENABLE_IP2', '1');
  ok(V.valueProblem(ip2, '192.168.1.1') !== null, 'the second address may not equal the first while it is on');
  ok(V.valueProblem(ip2, '192.168.100.1') === null, 'a different second address is fine');
  EDITS.set('LAN_IP_ADDR2', '192.168.1.1');
  ok(V.valueProblem(en2, '1') !== null, 'turning the second address on with it equal to the first is refused');
  EDITS.clear();
  Object.assign(S.VALUES, was);

  ok(V.tarProblem(new Uint8Array(512)) !== null, 'a header of zeros is not a tar archive');
  const th = new Uint8Array(512);
  th[0] = 0x61;
  th.set([0x75, 0x73, 0x74, 0x61, 0x72], 257);
  ok(V.tarProblem(th) === null, 'a 512-byte header with ustar at 257 is a tar archive');
  ok(V.tarProblem(th.slice(0, 300)) !== null, 'a short file is not a tar archive');
  ok(V.uploadSizeProblem(0) !== null && V.uploadSizeProblem(V.UPLOAD_MAX + 1) !== null
     && V.uploadSizeProblem(V.UPLOAD_MAX) === null, 'the upload size limit is 6 MiB, and empty is refused');
  ok(V.passwordProblem('admin', 'secret1', 'secret2') !== null, 'a repeated password that differs is refused');
  ok(V.passwordProblem('admin', 'secret1', 'secret1') === null, 'a repeated password that matches is fine');
}

renderStatus(API['/api/status'].raw);
ok(true, 'renderStatus runs against a diag capture');

/* The near-edge band scales with the window. A fixed 3 dB was more than half
   the 4.5 dB launch window and flagged a healthy +2.15 dBm transmitter. */
{
  const { OPTICS, tight } = await import(join(root, 'web', 'status.js'));
  ok(Math.abs(tight(OPTICS.tx) - 0.72) < 0.01 && Math.abs(tight(OPTICS.rx) - 3.04) < 0.01,
     'near the edge is 16% of each window: 0.72 dB tx, 3.04 dB rx');
  const tx = (v) => `RTK.0> pon get transceiver tx-power\n  Tx Power : ${v} dBm\n`;
  renderStatus(tx('2.15'));
  ok(doc.querySelector('#tx').className === 'meter v-ok', 'a +2.15 dBm transmitter is in window, not near the edge');
  renderStatus(tx('0.9'));
  ok(doc.querySelector('#tx').className === 'meter v-warn', 'and +0.9 dBm, 0.4 dB off the minimum, is near it');
  renderStatus(tx('0.2'));
  ok(doc.querySelector('#tx').className === 'meter v-bad', 'and +0.2 dBm is out of the window');
}

/* --- the chip temperature: the Status row and the header bar ------------- */
{
  const raw = API['/api/status'].raw;
  const row = () => textOf(doc.querySelector('#stick'));
  const chipDd = () => { const kids = doc.querySelector('#stick').children; const i = kids.findIndex((d) => textOf(d) === 'Chip temperature (SoC)'); return kids[i + 1]; };
  const bar = doc.querySelector('#chipbanner');
  renderStatus(raw);
  ok(row() === '' && doc.querySelector('#stickblock').hidden === true && bar.hidden === true,
     'chip temp: an image without the sensor shows no Stick block, no bar and no help');
  renderStatus(raw, { celsius: 71.3 });
  ok(row() === 'Chip temperature (SoC)71.3 °C' && bar.hidden === true && doc.querySelector('#stickblock').hidden === false
     && !/Chip temperature/.test(textOf(doc.querySelector('#env'))),
     'chip temp: the temperature alone is a plain number, in the Stick block with the help, not among the transceiver rows');
  renderStatus(raw, { celsius: 71.3, max: 95, crit: 110, max_alarm: false, crit_alarm: false });
  ok(textOf(chipDd()) === '71.3 °C' && chipDd().className === 'num' && bar.hidden === true, 'chip temp: normal is the number and nothing else');
  renderStatus(raw, { celsius: 96.4, max: 95, crit: 110, max_alarm: true, crit_alarm: false });
  const dd = chipDd();
  ok(textOf(dd) === '96.4 °C, above the warning limit (95 °C)' && dd.className === 'warn' && bar.hidden === true,
     'chip temp: the warning alarm styles the row and says the limit, without a bar');
  renderStatus(raw, { celsius: 112, max: 95, crit: 110, max_alarm: true, crit_alarm: true });
  ok(bar.hidden === false
     && /id="chipbanner" class="trial hot"/.test(readFileSync(join(root, 'web', 'index.html'), 'utf8'))
     && textOf(doc.querySelector('#chip-text')) === 'The chip is very hot (112 °C, limit 110 °C). Check the airflow around the router\'s SFP cage.',
     'chip temp: the critical alarm raises the header bar with the reading and the limit');
  ok(/<a id="chip-open" class="button" href="#status">/.test(readFileSync(join(root, 'web', 'index.html'), 'utf8')),
     'chip temp: the bar action carries the shared button class, as the other bars do');
  renderStatus(raw, { celsius: 112, crit_alarm: true });
  ok(textOf(doc.querySelector('#chip-text')).startsWith('The chip is very hot (112 °C). '),
     'chip temp: an alarm with no limit reported leaves the limit out');
  renderStatus(raw, { celsius: 80, max: 95, crit: 110, max_alarm: false, crit_alarm: false });
  ok(bar.hidden === true, 'chip temp: the bar goes when the alarm clears');
}

/* --- the bias current and the uptime ------------------------------------- */
{
  const { upFor } = await import(join(root, 'web', 'status.js'));
  ok(upFor(undefined) === null && upFor('') === null && upFor('12.5') === null && upFor('x') === null,
     'uptime: no member, or not whole seconds, is no row');
  ok(upFor('42') === 'under a minute' && upFor('600') === '10 min' && upFor('14105') === '3 h 55 min'
     && upFor('273600') === '3 d 4 h 0 min', 'uptime: days, hours and minutes, to the minute');
  const env = () => textOf(doc.querySelector('#env'));
  renderStatus('RTK.0> pon get transceiver bias-current\nBias Current: 14.050000 mA\n');
  ok(/Bias current14\.1 mA/.test(env()), 'bias: the diag reading, one decimal, among the transceiver rows');
  renderStatus('RTK.0> gpon get onu-state\n  Operation State(O5)\n');
  ok(/Bias current\u2014/.test(env()), 'bias: a dash when diag gave none');
  renderStatus('', null, { uptime: '14105' });
  ok(textOf(doc.querySelector('#stick')) === 'Uptime3 h 55 min' && doc.querySelector('#stickblock').hidden === false,
     'uptime: shows the Stick block without the chip sensor');
  renderStatus('', { celsius: 52.4 }, { uptime: '14105' });
  ok(textOf(doc.querySelector('#stick')) === 'Uptime3 h 55 minChip temperature (SoC)52.4 \u00b0C',
     'uptime: first in the Stick block, the chip temperature under it');
}

/* --- the stick diagram on top of the Status tab (overview.js) ------------ */
{
  const raw = 'RTK.0> pon get transceiver rx-power\n  Rx Power : -18.42 dBm\n'
    + 'RTK.0> pon get transceiver tx-power\n  Tx Power : 2.15 dBm\n'
    + 'RTK.0> pon get transceiver temperature\n  Temperature : 45.50 C\n'
    + 'RTK.0> gpon get onu-state\n  Operation State(O5)\n'
    + 'RTK.0> mib dump counter port all\nPort: 2\nifInOctets      :   1000000\nifOutOctets     :    500000\n';
  const raw2 = raw.replace('1000000', '1300000').replace('500000', '560000');
  const st = (cpu) => ({ raw, cpu, mem_total: '   27508 kB', mem_avail: '   14792 kB',
    onu_id: '13', host_link: '1\n', host_mode: '2500basex' });
  const ov = () => textOf(doc.querySelector('#overview'));
  const realNow = Date.now;
  let t = 1000000;
  Date.now = () => t;
  renderStatus(raw, { celsius: 52.4 }, st('100 0 100 800 0 0 0 0 0 0'));
  ok(/Fibre−18\.4dBm/.test(ov()) && /Laser 2\.15 dBm/.test(ov()) && /Module 45\.5 °C/.test(ov())
     && /O5 In service/.test(ov()) && /ONU-ID 13/.test(ov()) && /14\.4 MiB free/.test(ov())
     && /SoC 52 °C/.test(ov()) && /2\.5G \(2500BASE-X\)/.test(ov()) && /Linked/.test(ov()),
     'overview: every part shows its figure from one /api/status answer');
  ok(/Light in2\.15dBmLight out/.test(ov()), 'overview: the fibre names both directions, light in and light out');
  ok(/CPUmeasuring/.test(ov()) && /↓ measuring/.test(ov()), 'overview: CPU and rates wait for a second poll');
  t += 10000;
  renderStatus(raw2, null, st('150 0 150 900 0 0 0 0 0 0'));
  ok(/50 % busy/.test(ov()), 'overview: CPU busy is the non-idle share between two polls');
  ok(/↓ 30\.0 kB\/s/.test(ov()) && /↑ 6\.00 kB\/s/.test(ov()),
     'overview: the switch rates are the fibre port deltas, down what it receives, up what it sends');
  {
    const line = doc.querySelector('#overview').children[1];
    ok(line.className === 'ov-line ov-glass flowing' && textOf(line) === '\u2193 30.0 kB/s\u2191 6.00 kB/s',
       'overview: in service the fibre line moves and carries the two rates of the fibre side');
  }
  t += 10000;
  renderStatus(raw2, null, { raw: raw2, host_link: '0' });
  ok(/Memory—/.test(ov()) && /ONU-ID —/.test(ov()) && /No link/.test(ov()) && /CPUmeasuring/.test(ov()),
     'overview: a stock slot without those files shows dashes, and a host link down says so');

  /* The PON load has a section of its own, not a line on the diagram: the
     whole PON beside the figures of this stick would read as this stick.
     The figure, the rate and a bar. */
  const half = 291456000;        /* 80000 frames (10 s) half full of idle, FEC on: 36432 bytes a frame */
  const pon = (sf, idle, fec) => ({ ...st('100 0 100 800 0 0 0 0 0 0'),
    ds_superframe: String(sf), ds_gem_idle: String(idle), ...(fec === undefined ? {} : { ds_fec: fec }) });
  const block = doc.querySelector('#ponblock');
  const host = doc.querySelector('#pon');
  const read = () => textOf(host.children[0]);
  const all = () => textOf(host);
  const fill = () => host.children.map((c) => c.children.find((x) => /^pon-fill/.test(x.className))).find(Boolean);
  ok(block.hidden === true && all() === '' && !/PON load|in use/.test(ov()),
     'pon load: no section without the counters (a stock slot, an older driver), and nothing on the diagram');
  t += 10000;
  renderStatus(raw, null, pon(1000, 5000000000, '1'));
  ok(block.hidden === false && read() === 'measuring' && !fill() && /0 %25 %50 %75 %100 %$/.test(all()),
     'pon load: the first poll has nothing to compare with: an empty bar with its scale');
  t += 10000;
  renderStatus(raw, null, pon(81000, 5000000000 + half, '1'));
  ok(read() === '≈ 50% of the downstream in use' && /≈ 1166 of 2332 Mbit\/s sent to all ONUs/.test(all()),
     'pon load: half the payload idle is 50 %, past 32 bits of idle frames, with the rate it stands for');
  ok(fill().style.width === '50%' && fill().className === 'pon-fill mid', 'pon load: the bar is filled to the figure');
  t += 10000;
  renderStatus(raw, null, pon(161000, 5000000000 + half + 571253760, '1'));
  ok(read() === '≈ 2.0% of the downstream in use' && /≈ 46\.6 of 2332 Mbit\/s/.test(all())
     && fill().style.width === '2%' && fill().className === 'pon-fill lo',
     'pon load: under 10 % it shows one decimal');
  t += 10000;
  renderStatus(raw, null, pon(241000, 5000000000 + 2 * half + 571253760, '0'));
  ok(read() === 'measuring' && !fill(), 'pon load: FEC changing between two polls gives no figure');
  t += 10000;
  renderStatus(raw, null, pon(321000, 5000000000 + 2 * half + 571253760 + 80000 * 7776, '0'));
  ok(/^≈ 0\.0%/.test(read()) && /of 2488 Mbit\/s/.test(all()), 'pon load: with FEC off the whole 38880 bytes count, all idle is 0 %');
  t += 10000;
  renderStatus(raw.replace('(O5)', '(O2)'), null, pon(401000, 5000000000 + 3 * half + 571253760 + 80000 * 7776, '0'));
  ok(block.hidden === false && read() === '—' && !fill(), 'pon load: outside O5 the section stays, with a dash');
  t += 10000;
  renderStatus(raw, null, pon(481000, 5000000000 + 4 * half + 571253760 + 80000 * 7776, '0'));
  ok(read() === 'measuring', 'pon load: and back in O5 it starts over');
  {
    /* The colour of the bar follows the figure as it is shown. */
    const cls = (pct) => {
      t += 10000;
      renderStatus(raw, null, pon(0, 0, '1'));
      t += 10000;
      renderStatus(raw, null, pon(80000, Math.round(80000 * 36432 * (1 - pct / 100) / 5), '1'));
      return fill().className;
    };
    ok(cls(49.4) === 'pon-fill lo' && cls(50) === 'pon-fill mid' && cls(79.4) === 'pon-fill mid'
       && cls(79.6) === 'pon-fill hi' && cls(80) === 'pon-fill hi',
       'pon load: blue under 50 %, yellow from 50 %, red from 80 %, by the figure shown');
  }
  {
    const { ponLoad } = await import(join(root, 'web', 'status.js'));
    const s = (sf, idle) => ({ ds_superframe: String(sf), ds_gem_idle: String(idle), ds_fec: '1' });
    ponLoad(null);
    ok(ponLoad(s(0x40000000 - 40000, 0)) === null, 'pon load: no figure without an earlier poll');
    t += 10000;
    ok(Math.abs(ponLoad(s(40000, half)).pct - 50) < 1e-9, 'pon load: the 30-bit frame counter wraps');
    t += 10000;
    ok(ponLoad(s(120000, half - 1)) === null, 'pon load: an idle count that went backwards (a reboot) gives no figure');
    t += 10000;
    ok(ponLoad(s(120000 + 800000, 2 * half)) === null,
       'pon load: more frames than the time between the polls allows (a re-lock) gives no figure');
    t += 10000;
    ok(ponLoad(s(120000 + 880000, 2 * half + 80000 * 8000)) === null,
       'pon load: more idle bytes than the frames hold gives no figure');
    t += 10000;
    ok(ponLoad({ ...s(120000 + 960000, 3 * half + 80000 * 8000), ds_gem_idle_sat: '1' }) === null,
       'pon load: an interval in which the idle register read full gives no figure');
    t += 10000;
    ok(Math.abs(ponLoad({ ...s(120000 + 1040000, 4 * half + 80000 * 8000), ds_gem_idle_sat: '1' }).pct - 50) < 1e-9,
       'pon load: an old saturation does not spoil later intervals');
    t += 10000;
    ok(ponLoad({ ds_superframe: '5', ds_gem_idle: 'x' }) === null && ponLoad(s(80005, half)) === null,
       'pon load: a member that is not a number starts over');
    ponLoad(null);
  }
  Date.now = realNow;
}

/* --- the path loss meter, from the PON-ID --------------------------------- */
{
  const { renderStatus, pathLoss } = await import(join(root, 'web', 'status.js'));
  const raw = (rx) => `RTK.0> pon get transceiver rx-power\n  Rx Power: ${rx}  dBm\n`
    + 'RTK.0> pon get transceiver tx-power\n  Tx Power: 1.835830  dBm\n';
  const loss = () => doc.querySelector('#loss');
  const part = (cls) => loss().children.find((c) => c.className === cls);
  const rxNotes = () => doc.querySelector('#rx').children.filter((c) => c.className === 'm-note').map(textOf);
  const pid = (cls, ext, tol) => ({ pon_id: `odn_class ${cls} reach_extender ${ext} tol ${tol} id 00112233445566 ms 5` });

  renderStatus(raw('-16.252517'), null, {});
  ok(loss().hidden === true && rxNotes().length === 1, 'path loss: no meter and no line without a PON-ID');
  renderStatus(raw('-16.252517'), null, pid(2, 0, 334));
  ok(loss().hidden === false && textOf(part('m-read')) === '19.7dB'
     && loss().className === 'meter v-ok' && textOf(part('m-note')) === 'Estimate. OLT sends 3.4 dBm, class B+: 13 to 28 dB'
     && !/0011223344/.test(textOf(loss())) && rxNotes().length === 1,
     'path loss: a meter with the class range as window, the launch power under it, no identifier');
  const dims = () => part('instrument').children.find((c) => c.className === 'm-dims').children;
  ok(dims().length === 2 && textOf(dims()[1]).startsWith('8.3 dB') && dims()[0].className === 'dim',
     'path loss: the margin to the class limit, and none to the minimum drawn as tight');
  ok(part('instrument').children[0].children.find((c) => /^win/.test(c.className)).className === 'win upper',
     'path loss: only the upper end of the window is a margin to watch');
  renderStatus(raw('-10.00'), null, pid(2, 0, 334));
  ok(loss().className === 'meter v-ok', 'path loss: near the class minimum is not near the edge');
  renderStatus(raw('-23.00'), null, pid(2, 0, 334));
  ok(loss().className === 'meter v-warn', 'path loss: near the class limit is near the edge');
  renderStatus(raw('-27.00'), null, pid(2, 0, 334));
  ok(loss().className === 'meter v-bad' && textOf(dims()[0]).startsWith('2.4 dB'),
     'path loss: over the class limit says by how much');
  renderStatus(raw('-16.00'), null, pid(2, 1, 300));
  ok(textOf(part('m-note')) === 'Estimate. Reach extender sends 0.0 dBm, class B+: 13 to 28 dB', 'path loss: a reach extender is named');
  renderStatus(raw('-17.00'), null, pid(9, 0, 300));
  ok(loss().hidden === true && rxNotes()[1] === 'Path loss about 17.0 dB (OLT sends 0.0 dBm)',
     'path loss: an unknown class gives a plain line, no window');
  ok(pathLoss(pid(2, 0, 65535), -17) === null && pathLoss({}, -17) === null && pathLoss(pid(2, 0, 334), null) === null
     && loss().hidden === true,
     'path loss: nothing without a launch power, a PON-ID or a receive reading');
}

/* --- the equalisation delay under Registration ---------------------------- */
{
  const { eqd } = await import(join(root, 'web', 'status.js'));
  const host = () => doc.querySelector('#ranging');
  const rows = () => host().children.map(textOf);
  const line = 'eqd_bits 283548 protection_path 0 min_resp_delay 0x00009132 multframe 2 inframe 9628';
  const at = (b) => ({ ranging: line.replace('283548', String(b)) });
  ok(eqd({ ranging: 'none' }) === null && host().hidden === true, 'eqd: hidden on ranging_time none');
  ok(eqd(at(283548)).bits === 283548 && host().hidden === false
     && rows().join('|') === 'EqD|283548 bit 227.9 µs',
     'eqd: the figure in bits and microseconds, also without localStorage');
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const day = Date.UTC(2026, 10, 12);
  const D = 86400000;
  ok(eqd(at(283549), day).from === null && rows().length === 2, 'eqd: no change on first sight');
  let r = eqd(at(283548), day + 1000);
  ok(r.base === 283549 && r.shown === false && rows().length === 2,
     'eqd: a bit or two after a reboot is kept quiet and does not move the settled figure');
  eqd(at(283427), day + D);
  ok(rows().join('|') === 'EqD|283427 bit 227.8 µs|Changed|−122 bit ≈ +10 m fibre, 2026-11-13',
     'eqd: a smaller figure equals more fibre, dated by when this browser first saw it');
  r = eqd(at(283428), day + 2 * D);
  ok(r.shown === true && r.base === 283427 && rows()[3] === '−122 bit ≈ +10 m fibre, 2026-11-13',
     'eqd: a bit of jitter after a change keeps the change and its day');
  store.clear();
  eqd(at(283548), day);
  for (const b of [283528, 283508]) eqd(at(b), day + D);
  ok(rows().length === 4 && rows()[3] === '−40 bit ≈ +3 m fibre, 2026-11-13',
     'eqd: steps under the threshold that add up to more are shown');
  eqd(at(283808), day + 3 * D);
  ok(rows()[3] === '+300 bit ≈ −25 m fibre, 2026-11-15', 'eqd: a larger figure equals less fibre');
  const before = store.get('odi-ui.eqd');
  ok(eqd({ ranging: line.replace('283548', '100000').replace('protection_path 0', 'protection_path 1') }, day) === null
     && host().hidden === true && store.get('odi-ui.eqd') === before,
     'eqd: a protection path figure is not shown and not kept');
  for (const bad of ['{"base":"x"}', '{"bits":283548,"prev":283427,"at":5}', '{"base":283548,"from":283427}',
                     '{"base":283548,"from":283427,"at":1e300}', '{"base":283548,"from":null,"at":5}', 'not json']) {
    store.set('odi-ui.eqd', bad);
    ok(eqd(at(283600), day).from === null && JSON.parse(store.get('odi-ui.eqd')).base === 283600,
       'eqd: a stored value that does not parse as the settled state starts over: ' + bad);
  }
  ok(eqd({}, day) === null && eqd({ ranging: 'eqd_bits x' }, day) === null, 'eqd: nothing without a figure');
  delete globalThis.localStorage;
}

/* --- the zones of the optics meters --------------------------------------- */
{
  const { renderStatus } = await import(join(root, 'web', 'status.js'));
  renderStatus('RTK.0> pon get transceiver rx-power\n  Rx Power : -16.40 dBm\n'
    + 'RTK.0> pon get transceiver tx-power\n  Tx Power : 1.87 dBm\n', null, {});
  const sc = (sel) => doc.querySelector(sel).children.find((c) => c.className === 'instrument').children[0].children;
  const by = (sel, cls) => sc(sel).find((c) => c.className === cls);
  ok(by('#rx', 'win').style['--t'] === '16%' && by('#tx', 'win').style['--t'] === '16%',
     'meter zones: the window carries the near-the-edge share its zones are drawn from');
  ok(Math.abs(parseFloat(by('#rx', 'out lo').style.width) - 100 * 3 / 26) < 0.01
     && Math.abs(parseFloat(by('#rx', 'out hi').style.width) - 100 * 4 / 26) < 0.01
     && Math.abs(parseFloat(by('#tx', 'out lo').style.width) - 100 * 3.5 / 11) < 0.01,
     'meter zones: both sides outside the window are marked, to the window limits');
}

/* --- the header bars are ordered by severity: red, yellow, blue ----------- */
{
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  const head = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  const bars = [...head.matchAll(/<div id="(\w+)" class="trial([^"]*)"/g)]
    .map((m) => ({ id: m[1], rank: /\bhot\b/.test(m[2]) ? 0 : /\bupdate\b/.test(m[2]) ? 2 : 1 }));
  ok(bars.map((b) => b.id).join() === 'chipbanner,trialbanner,safebanner,fallbackbanner,updatebanner',
     'bars: critical chip bar, then trial boot, safe mode, fallback, then the release notice');
  ok(bars.every((b, i) => i === 0 || bars[i - 1].rank <= b.rank),
     'bars: red first, then the yellow stripes, then the blue notice, never the other way round');
  ok((head.match(/class="trial/g) || []).length === bars.length, 'bars: every header bar is in that list');
}

/* --- the stick clock under NTP_SERVER ------------------------------------ */
{
  const { ntpLine } = await import(join(root, 'web', 'config.js'));
  const seen = Date.UTC(2026, 9, 18, 7, 52, 10) ;           /* browser: 2026-10-18 07:52:10 UTC */
  const at = (hms) => Date.UTC(2026, 9, 18, ...hms.split(':').map(Number)) / 1000;
  const synced = { event: 'step', time: String(at('07:41:00')), offset: '0.004', stratum: '2', last_sync: String(at('07:41:00')) };

  let p = ntpLine({ now: at('07:52:12'), ntp: synced }, seen, 'pool.ntp.org');
  ok(p.clock === 'Stick clock 2026-10-18 07:52:12 UTC, 2 s ahead of this browser' && !p.clockWarn,
     'ntp line: a stick 2 s ahead says so, without a warning');
  ok(p.ntp === 'Last NTP sync 07:41 UTC, corrected 0.004 s' && !p.ntpWarn,
     'ntp line: a synced stick shows the sync time and the correction');

  p = ntpLine({ now: at('07:52:11'), ntp: synced }, seen, 'pool.ntp.org');
  ok(p.clock.endsWith('matches this browser'), 'ntp line: under 2 s matches this browser');

  p = ntpLine({ now: at('07:50:00'), ntp: synced }, seen, 'pool.ntp.org');
  ok(p.clock.includes('2 min behind this browser') && p.clockWarn && p.clock.endsWith('one of the two clocks is wrong'),
     'ntp line: more than a minute off is a warning that says one of the clocks is wrong');

  p = ntpLine({ now: 3, ntp: null }, seen, 'pool.ntp.org');
  ok(p.clockWarn && p.clock.includes('1970-01-01') && p.clock.includes('57 years behind'),
     'ntp line: a stick that never set its clock shows 1970 and a warning');

  p = ntpLine({ now: at('07:52:10'), ntp: null }, seen, 'pool.ntp.org');
  ok(p.ntp.startsWith('No sync yet') && p.ntpWarn, 'ntp line: a server set and no status file is "No sync yet"');
  p = ntpLine({ now: at('07:52:10'), ntp: null }, seen, '');
  ok(p.ntp === 'NTP is off' && !p.ntpWarn, 'ntp line: no server is "NTP is off"');
  p = ntpLine({ now: at('07:52:10'), ntp: { event: 'unsync', time: String(at('07:50:00')), offset: '', stratum: '16', last_sync: String(at('07:41:00')) } },
    seen, 'pool.ntp.org');
  ok(p.ntp === 'Lost sync (last sync 07:41 UTC)' && p.ntpWarn, 'ntp line: unsync names the last sync');
  p = ntpLine({ now: at('07:52:10'), ntp: { event: 'unsync', time: '1', offset: '', stratum: '16', last_sync: '' } }, seen, 'x');
  ok(p.ntp === 'Lost sync (never synced)', 'ntp line: unsync with no earlier sync says never synced');
  p = ntpLine({ now: at('07:52:10'), ntp: { event: 'periodic', time: String(at('07:52:00')), offset: '-0.0125', stratum: '2', last_sync: String(at('07:52:00')) } },
    seen, 'x');
  ok(p.ntp === 'Last NTP sync 07:52 UTC, corrected 0.0125 s', 'ntp line: a negative offset is shown as a size');
  p = ntpLine({ now: at('07:52:10'), ntp: { event: 'stratum', time: String(at('07:52:00')), offset: '', stratum: '3', last_sync: '' } }, seen, 'x');
  ok(p.ntp === 'Last NTP sync 07:52 UTC', 'ntp line: an empty offset is left out, the event time stands in for the sync');
  p = ntpLine({ now: at('07:52:10'), ntp: { ...synced, last_sync: String(at('07:52:10') - 86400 * 2) } }, seen, 'x');
  ok(/^Last NTP sync 2026-10-16 07:52 UTC/.test(p.ntp), 'ntp line: a sync on another day carries its date');
  p = ntpLine({ now: at('07:52:10'), ntp: { ...synced, offset: '1792321465.657234' } }, seen, 'x');
  ok(p.ntp === 'Last NTP sync 07:41 UTC, set the clock (it was 57 years off)', 'ntp line: the boot step from 1970 reads as setting the clock');
  p = ntpLine(null, seen, 'x');
  ok(p.clock === '' && p.ntp.startsWith('No sync yet'), 'ntp line: no answer at all does not throw');
}

/* --- the kernel log ------------------------------------------------------- */
const { renderLogLines } = await import(join(root, 'web', 'tools.js'));

/* Real shape, from Anime4000/RTL960x#30: a <4> header followed by CONTINUATION
   lines carrying no prefix of their own. Those inherit the last level seen --
   otherwise the switch error under a warning renders as ordinary text. */
const KLOG = [
  '<4>',
  '<4>create ani vlan for mbcast fail, ret = 65672',
  '[WARNING] Return Error (0x10088:RT_ERR_RG_VLAN_USED_BY_SYSTEM) at line:18390',
  '<6>eth0: link up',
].join('\n');

const logbox = doc.createElement('div');
renderLogLines(KLOG, logbox);
ok(logbox.children.length === 3, 'blank lines are dropped, real ones kept');
ok(logbox.children[0].classList.contains('warn'), 'a <4> line is a warning');
ok(logbox.children[1].classList.contains('warn'),
   'a continuation line inherits the level above it');
ok(!logbox.children[2].classList.contains('warn'), 'and a later <6> resets it');
ok(!/^<\d>/.test(logbox.children[0].textContent), 'the priority prefix is not shown');

/* --- the switch MAC table ------------------------------------------------- */
/*
 * The link check (web/linkcheck.js): one finding per failed stage, each case
 * the issue names told apart, and the tracker that turns polls into facts.
 */
{
  const LC = await import(join(root, 'web', 'linkcheck.js'));
  const base = { state: 'O5', los: false, rx: -18.2, onuId: 1, alloc: 3, o7Held: false, stalled: true,
                 omci: { state: 'O5', mibSync: 184, resets: { olt: 1, local: 0, windowS: 600, recent: 0, loop: false } },
                 gem: 6, traffic: { in: 1000, out: 500 }, idle: 0 };
  const run = (over) => LC.linkCheck({ ...base, ...over });
  const at = (r, k) => r.stages.find((x) => x.key === k).status;

  let r = run({});
  ok(r.finding.stage === null && r.finding.cls === 'good' && r.stages.every((x) => x.status === 'ok'),
     'link check: a working line passes all five stages');
  r = run({ los: true, state: 'O1' });
  ok(r.finding.stage === 'light' && at(r, 'light') === 'fail' && at(r, 'registered') === 'wait',
     'link check: LOS fails the light stage and stops there');
  r = run({ state: 'O3', onuId: null, ranged: false });
  ok(r.finding.stage === 'registered' && /does not know this serial/.test(r.finding.text)
     && /no ONU-ID/.test(r.stages[1].evidence), 'link check: never ranged since the stall is an unknown serial');
  r = run({ state: 'O2', onuId: null, ranged: true });
  ok(/PLOAM password/.test(r.finding.text) && !/serial number \(GPON_SN\)/.test(r.finding.text),
     'link check: ranged and dropped again is the password');
  r = run({ state: 'O3', onuId: null, ranged: undefined });
  ok(/serial number or PLOAM password/.test(r.finding.text), 'link check: not tracked says both');
  r = run({ state: 'O4', onuId: 5 });
  ok(/ranging does not complete/.test(r.finding.text) && /ONU-ID 5/.test(r.stages[1].evidence),
     'link check: stuck in O4 is not called a credential fault');
  r = run({ state: 'O3', onuId: null, stalled: false });
  ok(r.finding.cls === 'warn' && at(r, 'registered') === 'wait', 'link check: not stalled yet is still registering');
  r = run({ state: 'O7', o7Held: true });
  ok(/disabled this ONU/.test(r.finding.text) && /kept/.test(r.stages[1].evidence), 'link check: O7 is the OLT disabling it');
  r = run({ omci: { ...base.omci, resets: { olt: 5, local: 0, windowS: 600, recent: 4, loop: true } } });
  ok(r.finding.stage === 'omci' && /MIB reset loop/.test(r.finding.text) && /4 MIB resets/.test(r.stages[2].evidence),
     'link check: a MIB reset loop fails the OMCI stage');
  r = run({ omci: { ...base.omci, resets: { olt: 5, local: 0, windowS: 600, recent: 1, loop: true } } });
  ok(r.finding.stage === null && at(r, 'omci') === 'wait' && /clears after a quiet window/.test(r.stages[2].evidence),
     'link check: a loop that has stopped is said, not failed');
  r = run({ omci: { ...base.omci, mibSync: 0 }, gem: 0 });
  ok(r.finding.stage === 'omci' && /has not provisioned anything/.test(r.finding.text), 'link check: registered and never provisioned');
  r = run({ omci: { ...base.omci, mibSync: 0 }, gem: 0, stalled: false });
  ok(r.finding.cls === 'warn' && at(r, 'omci') === 'wait', 'link check: early in O5 it waits for the provisioning');
  r = run({ gem: 0 });
  ok(r.finding.stage === 'services' && /no GEM port/.test(r.finding.text), 'link check: provisioned without a service');
  r = run({ omci: null, gem: undefined });
  ok(at(r, 'omci') === 'unknown' && at(r, 'services') === 'unknown' && r.finding.stage === null,
     'link check: a stock image reports unknown, not a fault');
  r = run({ traffic: { in: 0, out: 0 }, idle: 3 });
  ok(r.finding.stage === 'traffic' && /nothing crosses/.test(r.finding.text), 'link check: services and no traffic');
  r = run({ traffic: { in: 0, out: 0 }, idle: 1 });
  ok(r.finding.cls === 'good' && at(r, 'traffic') === 'wait', 'link check: one quiet sample is not a fault');
  r = run({ traffic: null });
  ok(at(r, 'traffic') === 'wait' && /Measuring/.test(r.finding.text), 'link check: traffic needs two samples');
  ok(LC.linkCheck(null).finding.text === 'No answer from the stick yet.', 'link check: no answer');

  const st = `onu state  : O5
mib sync   : 184
programming: on
rx dropped : length 0  devid 0  crc 0  (trailer odd, answered: 0)
mib resets : olt 4  local 1  olt in last 600 s 3  loop yes  (loops 1)
`;
  const o = LC.omciState(st);
  ok(o.state === 'O5' && o.mibSync === 184 && o.resets.olt === 4 && o.resets.local === 1
     && o.resets.recent === 3 && o.resets.windowS === 600 && o.resets.loop === true, 'omcicli state: parsed');
  ok(LC.omciState(st.replace(/^mib resets.*\n/m, '')).resets === null, 'omcicli state: an older omcid has no reset line');
  ok(LC.omciState('') === null && LC.omciState('usage: omcicli ...') === null, 'omcicli state: no answer is null');
  ok(LC.onuIdOf('-1') === null && LC.onuIdOf('7') === 7 && LC.onuIdOf(undefined) === undefined,
     'onu_id: none, a number, not reported');
  ok(LC.allocCount('5 282 794 1050 1306 538') === 5 && LC.allocCount(undefined) === null, 'alloc_ids: the count');
  ok(LC.o7Held('keep 1 held 1') && !LC.o7Held('keep 1 held 0'), 'o7_hold: held');

  const ports = (i, o) => ({ 2: { ifInOctets: String(i), ifOutOctets: String(o) } });
  const facts = { state: 'O5', los: false, rx: -18 };
  let t = LC.trackLink(null, { facts, st: { onu_id: '1' }, ports: ports(100, 100) });
  ok(t.f.traffic === null && t.f.onuId === 1 && t.f.stalled === false, 'tracker: the first poll has no traffic yet');
  t = LC.trackLink(t.T, { facts, st: {}, ports: ports(150, 120) });
  ok(t.f.traffic.in === 50 && t.f.traffic.out === 20 && t.f.idle === 0, 'tracker: bytes between two polls');
  t = LC.trackLink(t.T, { facts, st: {}, ports: ports(10, 10) });
  ok(t.f.traffic === null, 'tracker: a counter reset is no sample');
  let T = t.T;
  for (let i = 0; i < 3; i++) T = LC.trackLink(T, { facts, st: {}, ports: ports(10, 10) }).T;
  ok(T.idle === 3, 'tracker: quiet polls are counted');
  T = null;
  for (let i = 0; i < 4; i++) t = LC.trackLink(T, { facts: { state: 'O3', los: false, rx: -18 }, st: {}, ports: {} }), T = t.T;
  ok(t.f.stalled === true && t.f.onuId === undefined && t.f.ranged === undefined,
     'tracker: four polls before O5 are a stall; a stock image tracks no ranging');
  const o3 = { state: 'O3', los: false, rx: -18 };
  t = LC.trackLink(null, { facts: o3, st: { onu_id: '-1' }, ports: {} });
  t = LC.trackLink(t.T, { facts: o3, st: { onu_id: '-1' }, ports: {} });
  ok(t.f.ranged === false, 'tracker: no transition line and no ONU-ID is never ranged');
  t = LC.trackLink(t.T, { facts: o3, st: { onu_id: '-1', o3_o4: '1' }, ports: {} });
  ok(t.f.ranged === true, 'tracker: an O3 to O4 between two polls counts, though no poll saw it');
  t = LC.trackLink(t.T, { facts: o3, st: { onu_id: '-1', o3_o4: '1' }, ports: {} });
  ok(t.f.ranged === true, 'tracker: and is kept until the line is back in O5');
  t = LC.trackLink(t.T, { facts: { ...o3, state: 'O5' }, st: { onu_id: '2', o3_o4: '2' }, ports: {} });
  t = LC.trackLink(t.T, { facts: o3, st: { onu_id: '-1', o3_o4: '2' }, ports: {} });
  ok(t.f.ranged === true, 'tracker: a drop out of O5 counts as having got that far');
}

const { parseL2 } = await import(join(root, 'web', 'l2.js'));
const L2 = readFileSync(join(root, 'scripts/fixtures/l2-table.txt'), 'utf8');
const l2rows = parseL2(L2);

ok(l2rows.length === 2, 'every learned address is found across the LUT stanzas');
ok(l2rows[0].MACAddress === '78:54:2E:07:64:63', 'the address is read');
ok(l2rows[0].Spa === '2', 'the source port is zipped against its own header');
ok(l2rows[0].Vid === '1' && l2rows[0].State === 'Auto',
   'later columns line up too');
/* The capture ends on a header with no row under it. A parser that assumed
   a row always follows would invent an entry or throw. */
ok(l2rows.every((r) => r.MACAddress), 'a header with no row under it yields no entry');

/* SYNTHETIC, and deliberately not in scripts/fixtures/: no capture in hand
   shows an address learned on the host side, and inventing one to put beside
   the real ones is how a fixture stops being evidence. This exercises only the
   port-number-to-side mapping. */
const SYNTH = 'MACAddress        Spa Fid Age Vid  State  Ext  Hash\n'
            + '02:00:00:00:00:01 0   0   1   1    Auto   0    SVL\n';
ok(parseL2(SYNTH)[0].Spa === '0', 'a port-0 row parses the same way');
/* The second stanza of each entry has its own header (CtagIf Auth DaBlock...)
   and a row of words -- none of which is a MAC, so none of it may become an
   entry of its own. */
ok(!l2rows.some((r) => r.MACAddress === 'Dis'), 'the per-entry flag rows are not mistaken for addresses');
ok(parseL2('').length === 0, 'no output yields no rows');

/* odi-oss diag answers the same command with its own listing: one header,
   one line per row, a summary line before and after. The rows are its golden
   test's, not a capture -- scripts/fixtures/omci/README.md says so. */
const { members } = await import(join(root, 'web', 'l2.js'));
const L2OSS = readFileSync(join(root, 'scripts/fixtures/l2-table-odi-oss.txt'), 'utf8');
const ossrows = parseL2(L2OSS);
ok(ossrows.length === 3, 'odi-oss: every row is found, the summary lines are not');
ok(ossrows[0].MACAddress === '78:54:2E:07:64:63' && ossrows[0].Spa === '2'
   && ossrows[0].Vid === '1' && ossrows[0].Age === '6' && ossrows[0].State === 'Auto',
   'odi-oss: the stock header words carry the same fields');
ok(ossrows[1].Spa === '0', 'odi-oss: a host-side address');
ok(ossrows[2].Type === 'mc' && ossrows[2].Ports === '0x1' && ossrows[2].State === 'Static',
   'odi-oss: a multicast group is marked, with its member mask');
ok(members('0x1') === 'host (port 0)', 'a member mask names the host side');
ok(members('0x5') === 'host (port 0), fibre (port 2)', 'and each member, in port order');
ok(members('0x0') === 'no ports', 'an empty mask says so');

/* --- restoring a backup --------------------------------------------------- */
const { parseBackup, classify, backupText } = await import(join(root, 'web', 'restore.js'));
const { encryptBackup } = await import(join(root, 'web', 'crypto.js'));

/* The shape `flash all` prints: hs first, then cs, both wrapped in <Dir>, with
   table rows distinguished only by an XML comment. */
const BACKUP = `
<Dir Name="HW_SETTING">
  <Value Name="GPON_SN" Value="ODI012345678"/>
  <Value Name="LAN_SDS_MODE" Value="4"/>
</Dir>
<Dir Name="MIB_TABLE">
  <Value Name="LAN_IP_ADDR" Value="192.168.0.3"/>
  <Value Name="VLAN_MANU_TAG_VID" Value="110"/>
  <Value Name="OMCI_CUSTOM_RDP" Value="4"/>
</Dir>
<Dir Name="SW_PORT_TBL"> <!--index=1-->
  <Value Name="PVID" Value="1"/>
</Dir>`;

const parsed = parseBackup(BACKUP);
ok(parsed.get('GPON_SN') === 'ODI012345678', 'a backup parses to name/value pairs');
ok(parsed.get('LAN_IP_ADDR') === '192.168.0.3', 'values from both stores are picked up');
ok(parsed.size === 6, 'every Value element is read, comments and Dir nesting included');
ok(parseBackup('not a backup at all').size === 0, 'a file that is not a backup yields nothing');

/* An encrypted backup: the right password gives the text, anything else gives
   a message and nothing to restore. Few rounds, the key derivation is tested
   elsewhere. */
{
  const msgs = { append(...n) { this.n.push(...n); }, n: [] };
  const sealed = encryptBackup(new TextEncoder().encode(BACKUP), 'secret', undefined, 200000);
  const plainBytes = new TextEncoder().encode(BACKUP);

  ok(backupText(plainBytes, '', msgs) === BACKUP, 'a plain backup is read as it is');
  ok(backupText(sealed, 'secret', msgs) === BACKUP, 'an encrypted backup is read with its password');
  ok(msgs.n.length === 0, 'and says nothing when it works');
  ok(backupText(sealed, 'wrong', msgs) === null && msgs.n.length === 1, 'a wrong password reads nothing and says so');
  ok(backupText(new TextEncoder().encode('not a backup'), '', msgs) === null && msgs.n.length === 2, 'a file that is no backup reads nothing');
  /* Valid padding is not proof of the right key: this is the one-in-256 case,
     where the plaintext is garbage that does not parse. */
  const garbage = encryptBackup(new TextEncoder().encode('garbage, no values here'), 'secret', undefined, 200000);
  ok(backupText(garbage, 'secret', msgs) === null && msgs.n.length === 3, 'decrypted text that is not a backup is refused');
}

/* VALUES has every key at '1', so everything in the backup differs. The point
   under test is WHERE each key lands. */
const plan = classify(parsed);
ok(plan.refused.includes('LAN_SDS_MODE'),
   'a SerDes key in a backup is refused, not restored');
ok(!plan.change.some(([n]) => n === 'LAN_SDS_MODE'),
   'and it never reaches the write list');
ok(plan.identity.some(([n]) => n === 'GPON_SN'),
   'identity keys are separated from ordinary ones');
ok(plan.change.some(([n]) => n === 'LAN_IP_ADDR'),
   'an ordinary key is queued for writing');
ok(!plan.change.some(([n]) => n === 'GPON_SN'),
   'and identity keys are not in that list unless asked for');

/* A key already holding the backup's value must not be rewritten: a restore
   that reports 184 writes tells you nothing about what actually changed. */
const same = classify(parseBackup('<Value Name="LAN_IP_ADDR" Value="1"/>'));
ok(same.same.includes('LAN_IP_ADDR') && same.change.length === 0,
   'a value that already matches is not rewritten');

/* What the daemon would refuse is said before anything is written, and the
   backup is judged as a whole: an address is checked against the mask in the
   same file, not the one on the stick. */
const inv = classify(parseBackup([
  '<Value Name="DNS1" Value="192.168.010.001"/>',
  '<Value Name="SNMP_SYS_NAME" Value="a&amp;b"/>',
  '<Value Name="LAN_IP_ADDR" Value="192.168.0.0"/>',
  '<Value Name="LAN_SUBNET" Value="255.255.255.0"/>',
  '<Value Name="VLAN_MANU_TAG_VID" Value="110"/>',
].join('\n')));
ok(inv.invalid.map(([n]) => n).sort().join() === 'DNS1,LAN_IP_ADDR,LAN_SUBNET,SNMP_SYS_NAME',
   'values the daemon would refuse are listed as skipped, not queued: ' + JSON.stringify(inv.invalid));
ok(inv.change.some(([n]) => n === 'VLAN_MANU_TAG_VID') && !inv.change.some(([n]) => n === 'DNS1'),
   'and the rest of the backup still restores');
const wide = classify(parseBackup('<Value Name="LAN_IP_ADDR" Value="192.168.1.0"/><Value Name="LAN_SUBNET" Value="255.255.0.0"/>'));
ok(wide.invalid.length === 0, 'an address is judged under the mask the backup carries (192.168.1.0 is a host on a /16): ' + JSON.stringify(wide.invalid));

/* --- the OMCI_CUSTOM_* bitmask decode ------------------------------------ */
const { decodeMask } = await import(join(root, 'web', 'state.js'));

/* 4 is what the stock firmware ships with, and what Anime4000/RTL960x#41 has
   been asking about since 2022. The answer is one row of features.tsv. */
const rdp = decodeMask('OMCI_CUSTOM_RDP', '4');
ok(rdp && rdp.known.length === 1 && rdp.known[0].names[0] === 'ignore_conn_uniNode_check',
   'OMCI_CUSTOM_RDP=4 decodes to ignore_conn_uniNode_check');
/* 258 = 0x102: the SFU default, two bits, one of them served by two modules. */
const bdp = decodeMask('OMCI_CUSTOM_BDP', '258');
ok(bdp && bdp.known.length === 2, 'OMCI_CUSTOM_BDP=258 decodes to two bits');
ok(bdp.known.some((b) => b.bit === 0x100 && b.names.length === 2),
   'a bit carrying two plugins reports both');
/* The value is decimal; a hex-looking string must not silently read as 0x. */
ok(decodeMask('OMCI_CUSTOM_ME', '65536').known[0].names[0] === 'accept_invalid_pq_instance_id',
   'OMCI_CUSTOM_ME=65536 is read as decimal');
const unk = decodeMask('OMCI_CUSTOM_RDP', '8');
ok(unk && unk.known.length === 0 && unk.unknown[0] === 8,
   'a bit with no plugin in this image is reported, not dropped');
ok(decodeMask('LAN_IP_ADDR', '1') === null, 'a key that is not a mask decodes to nothing');

/* --- the ME parser, against captured device output ----------------------- */
const { parseOmci, attr } = await import(join(root, 'web', 'omci.js'));

const p84 = parseOmci(OMCI[84]);
ok(p84.name === 'VlanTagFilterData', 'ME 84 reports the table name the device printed');
ok(p84.instances.length === 2, 'ME 84 yields both filter instances');
ok(p84.instances[0].id === '0x04', 'ME 84 EntityID (capital D) is picked up');
ok(attr(p84.instances[0], 'FwdOp') === '0x10', 'an attribute survives with its value');

const p171 = parseOmci(OMCI[171]);
ok(p171.instances.length === 1, 'ME 171 yields one instance');
ok(p171.instances[0].id === '0x02', 'ME 171 EntityId (lowercase d) is picked up too');
const idx = p171.instances[0].groups.find((g) => /^INDEX/.test(g.label));
ok(!!idx, 'the ReceivedFrameVlanTaggingOperTable rows are grouped by INDEX');
ok(idx.attrs.some(([k, v]) => k === 'Treatment Inner' && /VID 1600/.test(v)),
   'a keyless table row keeps its multi-word key');

/* The decoded page, on the same bytes. The claim under test is the one the
   page leads with: the OLT calls it 35 on your side and 1600 on the fibre. */
const { renderServices } = await import(join(root, 'web', 'services.js'));
await renderServices(true);
const cards = doc.querySelector('#services-cards');
ok(cards.children.length === 7, 'the Services tab renders a card per table');
const text = JSON.stringify(cards, (k, v) => (k === 'classList' ? undefined : v));
ok(/VLAN 1600/.test(text), 'the translation card names the VLAN on the fibre');
ok(/allows these VLANs on this line: 75, 1600/.test(text),
   'the filter card lists the VLANs the OLT permits');

/* Captured from our own sticks, so these assert what the DEVICE says. */
ok(/ODI|V1\.0-220923/.test(text), 'the software-image card shows a version');
ok(/running/.test(text) && /committed/.test(text),
   'Active and Committed are read -- the card assumed IsActive/IsCommitted and showed neither');
ok(/HWTC/.test(text), 'the OLT vendor code is decoded from its hex word');
ok(/carries both the physical Ethernet UNI and the VEIP/.test(text),
   'ISP1: the bridge carries the UNI and the VEIP');

/* The same card on the other line, which is the difference that matters. */
OMCI[47] = OMCI_ISP2_47;
await renderServices(true);
const isp2Text = JSON.stringify(doc.querySelector('#services-cards'),
                                (k, v) => (k === 'classList' ? undefined : v));
ok(/carries the VEIP, not the physical port/.test(isp2Text),
   'ISP2: the bridge carries the VEIP alone');
OMCI[47] = fx('47-MacBriPortCfgData-isp1.txt');

/* ISP1's real ME 171: most rows add no tag at all (treatment PRI 15, a 3-bit
   field, so out of range and unspecified). Rendering those as "VLAN 0" is a
   VLAN id nobody set, printed as though the OLT had set it -- which is what
   the live page did until a stick showed it. */
OMCI[171] = OMCI_ISP1_171;
await renderServices(true);
const c171 = JSON.stringify(doc.querySelector('#services-cards'),
                            (k, v) => (k === 'classList' ? undefined : v));
ok(/no tag added/.test(c171), 'an unset treatment reads as "no tag added"');
ok(!/VLAN 0/.test(c171), 'and never as VLAN 0');
OMCI[171] = fx('171-ExtVlanTagOperCfgData.txt');

/* --- a MIB service that has stopped answering --------------------------- */
const { unavailable } = await import(join(root, 'web', 'omci.js'));
ok(unavailable({ ok: true, raw: '', instances: [] }) !== null,
   'empty output is reported as unavailable, not as an empty table');
ok(unavailable({ ok: true, raw: 'TableId [1] Name: Anig!\n', instances: [] }) !== null,
   'a table listing in place of the table asked for is reported too');
ok(unavailable({ ok: true, raw: OMCI[84], instances: parseOmci(OMCI[84]).instances }) === null,
   'a real dump is not mistaken for a failure');

/* --- the MIB browser: tables, then entities, then attributes ----------- */
{
  const p84rows = parseOmci(OMCI[84]).instances;
  ok(p84rows.length === 2 && p84rows[0].raw.includes('EntityID: 0x04') && !p84rows[0].raw.includes('0x05'),
     'each parsed entity keeps its own raw lines, and only its own');

  const { renderMeBrowser, CATALOG } = await import(join(root, 'web', 'mebrowser.js'));
  const rowsOf = (sel) => doc.querySelector(sel).children.filter((node) => node.tagName === 'button');
  await renderMeBrowser();
  ok(rowsOf('#me-tables-list').length === CATALOG.length && CATALOG.length >= 82,
     `the MIB browser lists all ${CATALOG.length} classes`);
  ok(new Set(CATALOG.map((table) => table.classId)).size === CATALOG.length, 'each class id once');
  ok(CATALOG.every((table) => Number.isInteger(table.classId) && table.title && table.name),
     'every class has an id, an official name and a table name');
  ok(CATALOG.every((table) => table.query === String(table.classId)), 'every class is asked for by its id');
  const named = (id) => CATALOG.find((table) => table.classId === id);
  ok(named(268).title === 'GEM port network CTP' && named(263).title === 'ANI-G'
     && named(46).title === 'MAC bridge configuration data' && named(65529).title === 'ONU capability',
     'official names, including the classes the stock firmware lacks (46) and ours adds');
  ok(CATALOG.filter((table) => table.name === 'LargeString').map((table) => table.classId).join() === '157,307',
     'LargeString is two classes, 157 and 307, and two rows');
  const { meProblem } = await import(join(root, 'web', 'validate.js'));
  ok(CATALOG.every((table) => meProblem(table.query) === null),
     'every class id is one /api/omci accepts');
  ok(textOf(rowsOf('#me-tables-list').find((row) => textOf(row).startsWith('268'))).includes('GEM port network CTP')
     && textOf(rowsOf('#me-tables-list').find((row) => textOf(row).startsWith('268'))).includes('GemPortCtp'),
     'a row shows the official name and, under it, the table name');
  ok(rowsOf('#me-entities-list').length === 2, 'the default table (84) opens with its two entities');
  ok(textOf(doc.querySelector('#me-attrs-body')).includes('VID 75'), 'and the first entity\'s attributes');

  const table47 = rowsOf('#me-tables-list').find((row) => textOf(row).includes('MacBriPortCfgData'));
  await table47.onclick();
  const entities47 = parseOmci(OMCI[47]).instances;
  ok(rowsOf('#me-entities-list').length === entities47.length && entities47.length > 1,
     'opening a table lists every entity in its dump');
  rowsOf('#me-entities-list')[1].onclick();
  ok(doc.querySelector('#me-n-attrs').textContent.includes(
       '0x' + parseInt(entities47[1].id, 16).toString(16).padStart(4, '0')),
     'picking an entity shows that entity\'s attributes');
  doc.querySelector('#me-view-raw').onclick();
  ok(textOf(doc.querySelector('#me-attrs-body')) === entities47[1].raw, 'the raw view is that entity as printed');
  doc.querySelector('#me-view-parsed').onclick();
  ok(textOf(rowsOf('#me-tables-list').find((row) => textOf(row).includes('MacBriPortCfgData'))).endsWith(String(entities47.length)),
     'the table row counts the entities it read');

  doc.querySelector('#me-filter').value = '17';
  doc.querySelector('#me-filter').oninput();
  ok(rowsOf('#me-tables-list').some((row) => textOf(row).includes('ExtVlanTagOperCfgData'))
     && rowsOf('#me-tables-list').length < CATALOG.length, 'the filter matches a class id');
  doc.querySelector('#me-filter').value = 'gem port network';
  doc.querySelector('#me-filter').oninput();
  ok(rowsOf('#me-tables-list').some((row) => textOf(row).startsWith('268')), 'the filter matches an official name');
  doc.querySelector('#me-filter').value = 'macbriportcfg';
  doc.querySelector('#me-filter').oninput();
  ok(rowsOf('#me-tables-list').length === 1 && textOf(rowsOf('#me-tables-list')[0]).startsWith('47'),
     'and the vendor table name');
  doc.querySelector('#me-filter').value = '';
  doc.querySelector('#me-filter').oninput();
}

/* --- the odi-oss omcid dump shape -------------------------------------- */
/* SYNTHETIC, and not in scripts/fixtures/omci/: no capture of it is in hand
   yet. Built from the printf in odi-oss src/omci/respond/show.c (cli_row)
   and the first line a live stick answered for ME 268 ("268 GemPortCtp 1",
   then "    PortID 0fff ..."), which the Services card used to call "The
   OLT has not created any". It proves the parser reads that shape, and
   nothing about which attributes a real line carries. */
const ODI268 = [
  '268 GemPortCtp 1',
  '    PortID                   0fff',
  '    TcAdapterPtr             8000',
  '    Direction                03',
  '268 GemPortCtp 2',
  '    PortID                   0402',
  '    TcAdapterPtr             8001',
  '2 rows', '',
].join('\n');
const p268 = parseOmci(ODI268);
ok(p268.name === 'GemPortCtp' && p268.instances.length === 2 && p268.rows === 2,
   'odi-oss: every row is read, and the row count');
ok(attr(p268.instances[0], 'PortID') === '0x0fff' && Number(attr(p268.instances[1], 'PortID')) === 1026,
   'odi-oss: attribute bytes read as numbers');
const pVer = parseOmci('7 SWImage 0\n    Version                  56312e302d3232303932330000000000\n    Active                   01\n1 row\n');
ok(attr(pVer.instances[0], 'Version') === 'V1.0-220923', 'odi-oss: a string attribute reads as its text');

const SAVED = { 7: OMCI[7], 262: OMCI[262], 268: OMCI[268] };
OMCI[268] = ODI268;
OMCI[262] = '0 rows\n';
OMCI[7] = '0 rows\n';
await renderServices(true);
const odiText = JSON.stringify(doc.querySelector('#services-cards'),
                               (k, v) => (k === 'classList' ? undefined : v));
ok(/2 provisioned, by GEM port id: 4095, 1026/.test(odiText),
   'the GEM port card reads the odi-oss shape instead of reporting none');
ok(!/has not provisioned any|has not created any/.test(odiText),
   'an ONU-created entity answering 0 rows is never reported as none');
ok((odiText.match(/Could not read/g) || []).length >= 2,
   'it is reported as a read that came back incomplete');
OMCI[262] = '';
OMCI[268] = '0 rows\n';
await renderServices(true);
const noneText = JSON.stringify(doc.querySelector('#services-cards'),
                                (k, v) => (k === 'classList' ? undefined : v));
ok(/The MIB holds none/.test(noneText), 'a good empty read of an OLT-created table says none');
Object.assign(OMCI, SAVED);

/* T-CONTs the OLT never assigned carry Alloc-ID 255 (G.988 9.2.2), and a
   live ISP1 stick has eleven of them beside five in use. SYNTHETIC, in the
   odi-oss dump shape, with that stick's five Alloc-IDs. */
{
  const rows = [282, 794, 1050, 1306, 538, ...Array(11).fill(255)];
  OMCI[262] = rows.map((a, i) => `262 Tcont ${32768 + i}\n    AllocID                  ${a.toString(16).padStart(4, '0')}\n`).join('')
    + rows.length + ' rows\n';
  await renderServices(true);
  const tc = textOf(doc.querySelector('#services-cards'));
  ok(/5 assigned, by allocation id: 282, 794, 1050, 1306, 538/.test(tc), 'only T-CONTs with an Alloc-ID are counted as assigned');
  ok(/11 unassigned/.test(tc) && !/16 provisioned/.test(tc), 'and Alloc-ID 255 is counted as unassigned');
  OMCI[262] = SAVED[262];
}
{
  const { bytes } = await import(join(root, 'web', 'dom.js'));
  ok(bytes(123.456789) === '123.46 B' && bytes(12345.678) === '12.3 kB' && bytes(1234.5) === '1.23 kB',
     'a rate never shows more than two decimals');
}

/* --- the kernel log, as odi-oss writes it -------------------------------- */
const oss = doc.createElement('div');
const rOss = renderLogLines('<12>rcS: alive 517.79 s, free 13912 kB\nodi_wdt: alive at 492 s\n<11>rcS: omcid died\n', oss);
ok(oss.children.length === 1 && rOss.hidden === 2, 'heartbeat lines are hidden by default, and counted');
ok(oss.children[0].classList.contains('bad') && !/<\d+>/.test(textOf(oss.children[0])),
   'a <11> userland line is an error, and its facility prefix is stripped');
const oss2 = doc.createElement('div');
renderLogLines('<12>rcS: alive 517.79 s\n', oss2, { heartbeats: true });
ok(oss2.children.length === 1 && oss2.children[0].classList.contains('warn'), 'and shown on request, <12> as a warning');

/* --- what each firmware slot holds ---------------------------------------- */
const { slotKind } = await import(join(root, 'web', 'firmware.js'));
const fwStock = { slots: { 0: { kernel: 'Linux Kernel Image 6.18', built: 1759028976 },
                           1: { kernel: 'Linux Kernel Image', built: 1663932999 } } };
ok(slotKind(fwStock, '0').kind === 'odi', 'an odi-oss kernel header is recognised');
ok(slotKind(fwStock, '1').kind === 'stock' && slotKind(fwStock, '1').when === '2022-09-23',
   'the stock kernel header is recognised, with its build date');
ok(slotKind({ slots: { 1: {} } }, '1').kind === 'unknown', 'an unreadable slot is unknown, not assumed');

/* --- the trial-boot banner ------------------------------------------------ */
{
  const { renderTrial } = await import(join(root, 'web', 'firmware.js'));
  const st = await import(join(root, 'web', 'state.js'));
  const keepFW = st.S.FW;
  const bar = doc.querySelector('#trialbanner');
  st.S.FW = { env: { sw_active: '0', sw_commit: '1', sw_version1: 'V1.0-220923' }, fallback: {},
              slots: { 1: { kernel: 'Linux Kernel Image', built: 1663932999 } } };
  renderTrial();
  ok(bar.hidden === false, 'a trial boot raises the banner');
  const what = doc.querySelector('#trial-what').textContent;
  ok(/This image \(partition 0\) is not committed\. The next reboot returns to partition 1\./.test(what),
     'and says where the next reboot goes');
  ok(!/stock|holds/.test(what), 'without claiming what the other slot holds');
  ok(doc.querySelector('#trial-commit').hidden === false, 'with the Commit action');
  st.S.FW = { env: { sw_active: '0', sw_commit: '0' }, fallback: { sw_commit: '1' }, slots: {} };
  renderTrial();
  ok(bar.hidden === false && /fallback copy still names partition 1/.test(doc.querySelector('#trial-what').textContent),
     'a fallback copy naming another slot is a trial too');
  st.S.FW = { env: { sw_active: '0', sw_commit: '0' }, fallback: { sw_commit: '0' } };
  renderTrial();
  ok(bar.hidden === true, 'and a committed image with both copies agreeing has no banner');
  st.S.FW = { env: {} };
  renderTrial();
  ok(bar.hidden === true, 'an unreadable environment is not reported as a trial');
  /* The development files, next to the Commit action. */
  const dev = doc.querySelector('#trial-dev');
  const trialDev = (extra) => ({ env: { sw_active: '0', sw_commit: '1' }, fallback: {}, slots: {}, ...extra });
  st.S.FW = trialDev({});
  renderTrial();
  ok(dev.children.length === 0, 'no development file, no note beside Commit');
  st.S.FW = trialDev({ dev_confirm_arp: '192.168.1.2' });
  renderTrial();
  ok(/confirm-arp is set \(address 192\.168\.1\.2\): every boot of a committed slot needs an ARP reply from 192\.168\.1\.2, or it resets\. Remove \/etc\/config\/confirm-arp before committing\./
       .test(textOf(dev)) && dev.children[0].classList.contains('warn'),
     'confirm-arp with an address is a warning that names the address and the file');
  ok(doc.querySelector('#trial-commit').hidden === false && !/force/i.test(textOf(dev)),
     'Commit stays offered (the stick decides) and no force is offered');
  st.S.FW = trialDev({ dev_confirm_arp: '' });
  renderTrial();
  ok(/confirm-arp is present but has no address, so it has no effect\./.test(textOf(dev)),
     'confirm-arp without an address says it has no effect');
  st.S.FW = trialDev({ dev_breadcrumbs: true });
  renderTrial();
  ok(/breadcrumbs\.on is present: temporary debug logging/.test(textOf(dev)) && !dev.children[0].classList.contains('warn'),
     'breadcrumbs.on is a quiet note, not a warning');
  st.S.FW = { env: { sw_active: '0', sw_commit: '0' }, fallback: { sw_commit: '1' }, dev_confirm_arp: '10.0.0.1' };
  renderTrial();
  ok(dev.children.length === 0, 'without a Commit action the banner carries no development note');
  st.S.FW = keepFW;
}

/* --- the host-link banner and the Host port control ------------------------- */
{
  const { bannerText, trialLeft, renderHostlink } = await import(join(root, 'web', 'hostlink.js'));
  const keep = API['/api/hostlink'];
  const st = (o) => ({ setting: 'on', running: 'on', phase: 'steady', fallback: '0', ...o });

  let b = bannerText({ supported: true, state: st({}), safemode: null });
  ok(!b.show, 'host link: no banner in the default state');
  b = bannerText({ supported: true, state: st({ setting: 'off', running: 'off' }), safemode: null });
  ok(!b.show, 'host link: no banner while off runs as set');
  b = bannerText({ supported: true, state: st({ setting: 'off', running: 'on', fallback: '1' }), safemode: null });
  ok(b.show && !b.safe && !b.ack && /did not come up/.test(b.fallback) && !/\n/.test(b.fallback),
     'host link: the boot fallback raises its own bar, one short line, nothing to acknowledge');
  b = bannerText({ supported: true, state: st({}), safemode_now: null,
                  safemode: { short_boots: '5', cleared: 'none', build: 'v1.5.0' } });
  ok(b.show && b.ack && !b.fallback && /safe-mode boot happened \(build v1\.5\.0, after 5 short power cycles\)/.test(b.safe)
     && !/host port setting/.test(b.safe),
     'safe mode: a past safe-mode boot says the build and the count, with an acknowledgement');
  b = bannerText({ supported: true, state: st({}), safemode_now: { short_boots: '3', cleared: 'HOST_AUTONEG' },
                  safemode: { short_boots: '3', cleared: 'HOST_AUTONEG' } });
  ok(b.show && b.ack && /^Safe mode\./.test(b.safe) && /PON\) is off/.test(b.safe)
     && /default passwords/.test(b.safe) && /this boot only/.test(b.safe) && /host port setting/.test(b.safe)
     && b.safe.length < 220,
     'safe mode: this boot, one short line: PON off, default passwords for this boot only, what it cleared');
  b = bannerText({ supported: true, state: st({}), safemode_now: { short_boots: '5' }, safemode: null });
  ok(b.show && !b.ack && /Safe mode\./.test(b.safe) && /next boot is a normal boot/.test(b.safe),
     'safe mode: acknowledged during the boot, the bar stays without the button and says the next boot is normal');
  b = bannerText({ supported: false, state: {}, safemode_now: { short_boots: '5' }, safemode: {} });
  ok(b.show, 'safe mode: shown even on an image without host-autoneg.sh');
  b = bannerText({ supported: true, state: st({ setting: 'off', running: 'on', fallback: '1' }), safemode: {} });
  ok(b.safe && b.fallback && /several short/.test(b.safe), 'host link: a record and a fallback at once, two bars');
  ok(!bannerText({ supported: false, state: st({ fallback: '1', setting: 'off', running: 'on' }), safemode: null }).show,
     'host link: an image without host-autoneg.sh shows no fallback');
  ok(!bannerText(null).show, 'host link: an unreadable answer shows nothing');
  ok(trialLeft({ state: st({ phase: 'trial', trial_deadline: '420' }), uptime: '330' }) === 90,
     'host link: the countdown comes from the stick clock');
  ok(trialLeft({ state: st({}), uptime: '330' }) === null, 'host link: no trial, no countdown');

  API['/api/hostlink'] = { supported: true, state: st({ setting: 'off', running: 'on', fallback: '1' }),
                           safemode_now: null, safemode: { short_boots: '3' }, link: '1', uptime: '40' };
  await renderHostlink();
  const banner = doc.querySelector('#safebanner');
  ok(banner.hidden === false && doc.querySelector('#hostlink-ack').hidden === false,
     'host link: the safe-mode bar renders, with its Acknowledge button');
  ok(textOf(doc.querySelector('#safe-text')).includes('safe-mode boot happened'), 'host link: and its text');
  ok(doc.querySelector('#fallbackbanner').hidden === false
     && doc.querySelector('#safebanner').className === doc.querySelector('#trialbanner').className,
     'host link: the bars are the trial-boot band, and the fallback bar shows beside it');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  ok(/id="safe-details" href="#system\/access"/.test(html) && /<details[^>]*id="safemode-help"/.test(html),
     'host link: Details points at the safe-mode help on System, Access, which exists');
  ok(!/id="hostlinkbanner"/.test(html), 'host link: the big card is gone');
  ok(textOf(doc.querySelector('#hostlink-now')).includes('Host link'), 'host link: status rows render');
  ok(doc.querySelector('#hostlink').hidden === false, 'host link: the Host port block shows on an image that has it');
  ok(doc.querySelector('#hostlink-keep-on').hidden === false,
     'host link: in the fallback the block offers to keep auto-negotiation on');
  ok(doc.querySelector('#hostlink-try').dataset.mode === 'off', 'host link: and to try off again');
  API['/api/hostlink'] = keep;
  await renderHostlink();
  ok(banner.hidden === true && doc.querySelector('#fallbackbanner').hidden === true,
     'host link: the default state takes the bars down again');
  ok(doc.querySelector('#hostlink-keep-on').hidden === true, 'host link: and the keep-on offer');
  API['/api/hostlink'] = { supported: false, state: {}, safemode: null, link: '', uptime: '1' };
  await renderHostlink();
  ok(doc.querySelector('#hostlink').hidden === true, 'host link: no block on an image without host-autoneg.sh');
  API['/api/hostlink'] = keep;

  /* The SerDes mode (odi-oss HOST_SERDES, host-serdes.sh). */
  const sd = (o) => ({ supported: true, state: { setting: 'fiber1g', running: 'fiber1g', phase: 'steady', fallback: '0', ...o } });
  b = bannerText({ supported: true, state: st({}), serdes: sd({}), safemode_now: { short_boots: '3', cleared: 'HOST_SERDES' }, safemode: null });
  ok(/cleared the host port link mode/.test(b.safe) && !/auto-negotiation/.test(b.safe), 'safe mode: cleared=HOST_SERDES says the mode');
  b = bannerText({ supported: true, state: st({}), serdes: sd({}), safemode_now: { short_boots: '3', cleared: 'HOST_AUTONEG,HOST_SERDES' }, safemode: null });
  ok(/cleared the host port settings \(auto-negotiation and link mode\)/.test(b.safe) && b.safe.length < 260,
     'safe mode: cleared=HOST_AUTONEG,HOST_SERDES says both');
  b = bannerText({ supported: true, state: st({}), serdes: sd({}), safemode_now: { short_boots: '5', cleared: 'OMCI_UNI_LOCK' }, safemode: null });
  ok(/turned off "Honour an OLT lock of the Ethernet port"/.test(b.safe) && !/host port/.test(b.safe),
     'safe mode: cleared=OMCI_UNI_LOCK names the OLT lock setting');
  b = bannerText({ supported: true, state: st({}), serdes: sd({}), safemode_now: { short_boots: '3', cleared: 'HOST_AUTONEG,HOST_SERDES,OMCI_UNI_LOCK' }, safemode: null });
  ok(/auto-negotiation and link mode/.test(b.safe) && /OLT lock/.test(b.safe) && b.safe.length < 330,
     'safe mode: all three cleared, all three said');
  for (const c of ['none', 'failed', '']) {
    b = bannerText({ supported: true, state: st({}), safemode_now: { short_boots: '3', cleared: c }, safemode: null });
    ok(!/cleared the host port|turned off/.test(b.safe), `safe mode: cleared=${c || '(empty)'} claims nothing was cleared`);
  }
  b = bannerText({ supported: false, state: {}, serdes: sd({ setting: '2500basex', running: 'fiber1g', fallback: '1' }), safemode: null });
  ok(b.show && !b.safe && /^Host mode fallback\./.test(b.fallback) && /set to 2\.5G/.test(b.fallback) && /Fiber 1G/.test(b.fallback),
     'host mode: the boot fallback of 2.5G raises its bar, even on an image without host-autoneg.sh');
  ok(!bannerText({ supported: true, state: st({}), serdes: sd({ setting: 'fiber1g', running: 'fiber1g', fallback: '1' }), safemode: null }).show,
     'host mode: no fallback bar when the setting is Fiber 1G');
  ok(!bannerText({ supported: true, state: st({}), serdes: { supported: false, state: { setting: '2500basex', running: 'fiber1g', fallback: '1' } },
                   safemode: null }).show, 'host mode: an image without host-serdes.sh shows no fallback');
  ok(trialLeft({ state: st({}), serdes: sd({ phase: 'trial', trial_mode: '2500basex', trial_deadline: '420' }), uptime: '330' }) === 90,
     'host mode: the countdown of a SerDes trial comes from the stick clock');

  API['/api/hostlink'] = { supported: true, state: st({}), serdes: sd({ setting: 'fiber1g', running: '2500basex' }),
                           safemode_now: null, safemode: null, link: '1', uptime: '40' };
  await renderHostlink();
  ok(doc.querySelector('#hostlink-sd').hidden === false, 'host mode: the SerDes control shows on an image that has host-serdes.sh');
  const modes = doc.querySelector('#hostlink-sd-mode').children;
  ok(modes.map((o) => o.value).join() === 'fiber1g,2500basex,hisgmii'
     && modes[0].textContent === 'Fiber 1G (1000BASE-X, default, most compatible)'
     && modes[1].textContent === '2.5G (2500BASE-X)' && modes[2].textContent === 'HiSGMII',
     'host mode: the three modes, in plain words');
  const sdHtml = readFileSync(join(root, 'web', 'index.html'), 'utf8').replace(/\s+/g, ' ');
  ok(/unreachable until the trial reverts by itself, after 120 seconds/.test(sdHtml)
     && /2\.5G runs with auto-negotiation off/.test(sdHtml),
     'host mode: it says what a wrong mode costs and that 2.5G runs with auto-negotiation off');
  ok(doc.querySelector('#hostlink-try').disabled === true && doc.querySelector('#hostlink-an-na').hidden === false
     && /not applicable in 2\.5G/.test(textOf(doc.querySelector('#hostlink-now'))),
     'host mode: in 2.5G the auto-negotiation control says it is not applicable');
  API['/api/hostlink'].status = { autoneg: 'off', link: '1', link_source: 'serdes_sync' };
  API['/api/hostlink'].ok = true;
  await renderHostlink();
  await new Promise((r) => setImmediate(r));
  ok(/Auto-negotiation now.*off \(set by the 2\.5G \(2500BASE-X\) link mode\)/.test(textOf(doc.querySelector('#hostlink-now')))
     && /from the host link sync/.test(textOf(doc.querySelector('#hostlink-now'))),
     'host mode: while the link mode owns the port, the row shows the bit the status reports');
  ok(/Link mode now/.test(textOf(doc.querySelector('#hostlink-now'))), 'host mode: the status rows name the link mode');
  ok(/2\.5G \(2500BASE-X\)/.test(textOf(doc.querySelector('#hostlink-now'))) && !/most compatible/.test(textOf(doc.querySelector('#hostlink-now'))),
     'host mode: the rows say the short mode name, not the select label');
  ok(!/SerDes mode/.test(textOf(doc.querySelector('#hostlink-now'))) && />Link mode</.test(readFileSync(join(root, 'web', 'index.html'), 'utf8')),
     'host mode: the user-facing name is Link mode');
  ok(doc.querySelector('#hostlink-an-fb').hidden === true, 'host mode: no fallback note while the mode runs as stored');
  API['/api/hostlink'] = { supported: true, state: st({}), serdes: sd({ setting: '2500basex', running: 'fiber1g', fallback: '1' }),
                           safemode_now: null, safemode: null, link: '1', uptime: '40' };
  await renderHostlink();
  ok(doc.querySelector('#hostlink-try').disabled === false && doc.querySelector('#hostlink-an-fb').hidden === false
     && /stored link mode is 2\.5G \(2500BASE-X\); this boot runs Fiber 1G after a fallback, so a change here lasts until the next boot/
       .test(doc.querySelector('#hostlink-an-fb').textContent),
     'host mode: after a fallback the auto-negotiation control stays usable and says its change lasts until the next boot');
  API['/api/hostlink'] = { supported: true, state: st({}), serdes: sd({}), safemode_now: null, safemode: null, link: '1', uptime: '40' };
  await renderHostlink();
  ok(doc.querySelector('#hostlink-try').disabled === false && doc.querySelector('#hostlink-an-na').hidden === true,
     'host mode: back in Fiber 1G the auto-negotiation control works again');
  API['/api/hostlink'] = { supported: false, state: {}, serdes: sd({}), safemode: null, link: '', uptime: '1' };
  await renderHostlink();
  ok(doc.querySelector('#hostlink').hidden === false && doc.querySelector('#hostlink-an').hidden === true,
     'host mode: an image with only host-serdes.sh shows the SerDes control alone');
  API['/api/hostlink'] = { supported: false, state: {}, safemode: null, link: '', uptime: '1' };
  await renderHostlink();
  ok(doc.querySelector('#hostlink').hidden === true, 'host mode: and neither script, no block');
  API['/api/hostlink'] = keep;
}

/* --- the management address trial ---------------------------------------- */
{
  const na = await import(join(root, 'web', 'netaddr.js'));
  const st = (o) => ({ phase: 'trial', applied: '1', trial_deadline: '420', prev_ip: '192.168.0.1',
                       old_LAN_ENABLE_IP2: '0', old_LAN_IP_ADDR2: '192.168.100.1',
                       new_LAN_IP_ADDR: '10.1.1.1', new_LAN_ENABLE_IP2: '0', new_LAN_IP_ADDR2: '192.168.100.1', ...o });
  const keep = API['/api/netaddr'];
  /* No real network and no real waiting: a loop left running would hold the process. */
  na.deps.probe = async () => false;
  na.deps.sleep = () => new Promise((r) => setImmediate(r));
  na.deps.navigate = () => {};

  ok(na.NET_KEYS.join() === 'LAN_IP_ADDR,LAN_SUBNET,LAN_ENABLE_IP2,LAN_IP_ADDR2,LAN_SUBNET2,LAN_ROUTES'
     && na.isNetKey('LAN_SUBNET2') && na.isNetKey('LAN_ROUTES') && !na.isNetKey('HOST_AUTONEG') && !na.isNetKey('LAN_SDS_MODE'),
     'address trial: the five address keys and the static routes, and no other');
  ok(na.trialLeft({ state: st({}), uptime: '330' }) === 90, 'address trial: the countdown comes from the stick clock');
  ok(na.trialLeft({ state: st({ phase: 'steady' }), uptime: '330' }) === null, 'address trial: no trial, no countdown');
  ok(na.freshAddrs({ state: st({}) }).join() === '10.1.1.1', 'address trial: the new primary is the address to keep on');
  ok(na.freshAddrs({ state: st({ new_LAN_IP_ADDR: '192.168.0.1' }) }).length === 0,
     'address trial: nothing is new when only the netmask moved');
  ok(na.freshAddrs({ state: st({ new_LAN_IP_ADDR: '192.168.0.1', new_LAN_ENABLE_IP2: '1', new_LAN_IP_ADDR2: '172.20.0.1' }) }).join() === '172.20.0.1',
     'address trial: a new second address is the one to keep on');
  ok(na.freshAddrs({ state: st({ new_LAN_IP_ADDR: '192.168.100.1', old_LAN_ENABLE_IP2: '1' }) }).length === 0,
     'address trial: the old second address as the new primary already answered');
  let v = na.dialogView({ state: st({}), via: '192.168.0.1' });
  ok(!v.canKeep && v.link === 'http://10.1.1.1/' && /already had/.test(v.text) && /Revert works from here/.test(v.text),
     'address trial: on the old address the dialog points at the new one and offers no Keep');
  v = na.dialogView({ state: st({}), via: '10.1.1.1' });
  ok(v.canKeep && v.link === null && /new address \(10\.1\.1\.1\)/.test(v.text),
     'address trial: on the new address Keep is offered');
  v = na.dialogView({ state: st({ new_LAN_IP_ADDR: '192.168.0.1' }), via: '192.168.0.1' });
  ok(v.canKeep && /netmask/.test(v.text), 'address trial: a netmask-only change leaves the decision to the stick');

  /* The static routes ride the same trial: when they are all that changes there is no address to prove. */
  const rt = (o) => st({ new_LAN_IP_ADDR: '192.168.0.1', old_LAN_IP_ADDR: '192.168.0.1', old_LAN_SUBNET: '255.255.255.0',
    new_LAN_SUBNET: '255.255.255.0', old_LAN_ROUTES: '', new_LAN_ROUTES: 'default via 192.168.0.254', ...o });
  ok(na.routesOnly({ state: rt({}) }), 'routes trial: only LAN_ROUTES differs, so it is a routes-only trial');
  ok(!na.routesOnly({ state: rt({ new_LAN_SUBNET: '255.255.0.0' }) }) && !na.routesOnly({ state: rt({ new_LAN_ROUTES: '' }) })
     && !na.routesOnly({ state: st({}) }), 'routes trial: an address change, or no change of the routes, is not routes-only');
  v = na.dialogView({ state: rt({}), via: '192.168.0.1' });
  ok(v.canKeep && v.link === null && /static routes/.test(v.text) && /page stays/.test(v.text),
     'routes trial: the dialog offers Keep on this page, with no new address to open');
  ok(na.redirectTargets({ state: rt({}), via: '192.168.0.1' }).length === 0, 'routes trial: nothing to redirect to');
  ok(v.title === 'Keep the new static routes?', 'routes trial: the title names the routes');
  ok(na.dialogView({ state: st({}), via: '10.1.1.1' }).title === 'Keep the new management address?',
     'address trial: the title is the address one');
  const both = na.dialogView({ state: st({ old_LAN_ROUTES: '', new_LAN_ROUTES: 'default via 10.1.1.9' }), via: '10.1.1.1' });
  ok(both.title === 'Keep the new management address and static routes?' && /static routes were tried with it/.test(both.text),
     'address and routes trial: the title and the text name both');

  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  for (const id of ['netaddr-dialog', 'netaddr-count', 'netaddr-text', 'netaddr-link', 'netaddr-keep', 'netaddr-revert',
                    'netaddr-dialog-out', 'netaddr-follow', 'netaddr-result', 'netaddr-result-text', 'netaddr-result-link', 'netaddr-result-ok']) {
    ok(html.includes(`id="${id}"`), `address trial: index.html has #${id}`);
  }

  API['/api/netaddr'] = { supported: true, state: { phase: 'steady' }, via: '192.168.0.1', peer: '192.168.0.50', uptime: '300' };
  await na.renderNetaddr();
  ok(na.netaddrActive(), 'address trial: an image with the script is active');
  API['/api/netaddr'] = { supported: false, state: {}, via: '192.168.0.1', peer: '', uptime: '300' };
  await na.renderNetaddr();
  ok(!na.netaddrActive(), 'address trial: an image without it, or a safe-mode boot, is not');
  API['/api/netaddr'] = { supported: true, state: st({}), via: '192.168.0.1', peer: '', uptime: '330' };
  await na.renderNetaddr();
  ok(doc.querySelector('#netaddr-dialog').hidden === false && doc.querySelector('#netaddr-keep').disabled === true
     && /Reverting in 90 s/.test(textOf(doc.querySelector('#netaddr-count')))
     && doc.querySelector('#netaddr-link').href === 'http://10.1.1.1/',
     'address trial: a page loaded mid-trial raises the dialog with the countdown and the new address');
  na.stopFollow();

  /* The redirect: where the browser is sent, and how the page finds out the
     new address answers. */
  ok(na.originOf('10.1.1.1', {}) === 'http://10.1.1.1/'
     && na.originOf('10.1.1.1', { protocol: 'https:', port: '8443' }) === 'https://10.1.1.1:8443/',
     'redirect: the scheme and the port the page was loaded with are kept');
  ok(na.redirectTargets({ state: st({}), via: '192.168.0.1' }).join() === 'http://10.1.1.1/',
     'redirect: from the old address the target is the new one');
  ok(na.redirectTargets({ state: st({}), via: '10.1.1.1' }).length === 0,
     'redirect: a page already on the new address goes nowhere');
  ok(na.redirectTargets({ state: st({ new_LAN_IP_ADDR: '192.168.0.1' }), via: '192.168.0.1' }).length === 0,
     'redirect: a netmask-only change has no address to go to');
  ok(na.redirectTargets({ state: st({ new_LAN_ENABLE_IP2: '1', new_LAN_IP_ADDR2: '172.20.0.1' }), via: '192.168.0.1' }).join()
     === 'http://10.1.1.1/,http://172.20.0.1/',
     'redirect: a new second address is a target too, after the primary');
  ok(na.redirectTargets({ state: st({ new_LAN_IP_ADDR: '192.168.0.1', new_LAN_ENABLE_IP2: '1', new_LAN_IP_ADDR2: '172.20.0.1' }), via: '192.168.0.1' }).join()
     === 'http://172.20.0.1/', 'redirect: only the second address changed, only it is a target');
  const seen = [];
  const answers = async (u, o) => { seen.push([u, o]); return {}; };
  const refuses = async () => { throw new TypeError('Failed to fetch'); };
  ok(await na.probeAddr('http://10.1.1.1/', answers, 50) === true
     && seen[0][1].mode === 'no-cors' && seen[0][1].credentials === 'omit' && seen[0][1].cache === 'no-store'
     && /^http:\/\/10\.1\.1\.1\/\?probe=\d+$/.test(seen[0][0]),
     'redirect: the probe is a no-cors fetch with no credentials, which needs no CORS grant');
  ok(await na.probeAddr('http://10.1.1.1/', refuses, 50) === false, 'redirect: an address that does not answer is not found');
  const only = (want) => async (u) => u === want;
  ok(await na.firstAnswering(['http://a/', 'http://b/'], only('http://b/')) === 'http://b/'
     && await na.firstAnswering(['http://a/', 'http://b/'], async () => true) === 'http://a/'
     && await na.firstAnswering(['http://a/'], async () => false) === null,
     'redirect: the first address that answers wins, the primary before the second');
  {
    let round = 0;
    const log = [], went = [];
    const hit = await na.followLoop(['http://10.1.1.1/'], {
      alive: () => true, probe: async () => ++round > 5, sleep: async () => {},
      status: (k) => log.push(k), go: (u) => went.push(u),
    });
    ok(hit === 'http://10.1.1.1/' && went.join() === 'http://10.1.1.1/' && log[0] === 'looking'
       && log.includes('stuck') && log[log.length - 1] === 'found',
       'redirect: it keeps looking, says so when nothing answers, and goes when it does');
    let n = 0;
    const gone = [];
    const none = await na.followLoop(['http://10.1.1.1/'], {
      alive: () => ++n < 4, probe: async () => false, sleep: async () => {}, status: () => {}, go: (u) => gone.push(u),
    });
    ok(none === null && !gone.length, 'redirect: when the trial ends it stops and goes nowhere');
  }
  ok(/password again/.test(na.followText('found', 'http://10.1.1.1/')) && /Revert/.test(na.followText('stuck', ['http://10.1.1.1/'])),
     'redirect: the page says the password is asked again, and what to do when nothing answers');
  {
    const store = new Map();
    globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const h = { state: st({}), via: '192.168.0.1' };
    ok(!na.wasFollowed(h), 'redirect: a new trial has not been followed');
    na.markFollowed(h);
    ok(na.wasFollowed(h) && !na.wasFollowed({ state: st({ trial_deadline: '999' }) }),
       'redirect: followed once per trial, so Back from the new address does not bounce again');
    globalThis.sessionStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    ok(na.wasFollowed(h) === false, 'redirect: storage blocked, the page still works');
    store.clear();
    globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const went = [];
    na.deps.navigate = (u) => went.push(u);
    na.deps.sleep = () => new Promise((r) => setImmediate(r));
    na.deps.probe = async () => true;
    API['/api/netaddr'] = { supported: true, state: st({}), via: '192.168.0.1', peer: '', uptime: '330' };
    await na.renderNetaddr();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    ok(went.join() === 'http://10.1.1.1/' && store.get('odi-netaddr-followed') === '420',
       'redirect: a page on the old address, mid-trial, opens the new address once it answers');
    na.stopFollow();
    API['/api/netaddr'] = keep;
    await na.renderNetaddr();
    went.length = 0;
    API['/api/netaddr'] = { supported: true, state: st({}), via: '192.168.0.1', peer: '', uptime: '331' };
    await na.renderNetaddr();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    ok(!went.length && /does not do it again/.test(textOf(doc.querySelector('#netaddr-follow'))),
       'redirect: coming back to the old page does not redirect again, and says so');
    na.stopFollow();
    store.clear();
    API['/api/netaddr'] = { supported: true, state: st({ new_LAN_IP_ADDR: '192.168.0.1' }), via: '192.168.0.1', peer: '', uptime: '331' };
    await na.renderNetaddr();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    ok(!went.length, 'redirect: a netmask-only trial opens nothing');
    na.stopFollow();
    na.deps.probe = async () => false;
    API['/api/netaddr'] = { supported: true, state: st({}), via: '192.168.0.1', peer: '', uptime: '331' };
    await na.renderNetaddr();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    ok(!went.length && /(Looking for the new address|does not answer from this computer yet)/.test(textOf(doc.querySelector('#netaddr-follow'))) && /10\.1\.1\.1/.test(textOf(doc.querySelector('#netaddr-follow'))),
       'redirect: while nothing answers the page stays, says what it is waiting for');
    na.stopFollow();
    na.deps.probe = null; na.deps.sleep = null;
    delete globalThis.sessionStorage;
  }
  API['/api/netaddr'] = keep;
  await na.renderNetaddr();
}

/* --- the Firmware subtab ------------------------------------------------ */
{
  const { renderFirmware } = await import(join(root, 'web', 'firmware.js'));
  const keep = API['/api/firmware'];
  const fwText = async (fw) => {
    API['/api/firmware'] = fw;
    await renderFirmware();
    return textOf(doc.querySelector('#parts'));
  };
  const trialFW = { env: { sw_active: '1', sw_commit: '0', sw_tryactive: '2' }, fallback: {},
                    slots: {}, build: { image: 'v1.0.8', confd: 'local' }, confd: 'v1.0.8-dirty' };
  let t = await fwText({ ...trialFW, exe: '/bin/confd' });
  ok(!/override/.test(t), 'a local build (confd=local) run from /bin/confd is not called an override');
  ok(!/Try partition/.test(t), 'mid-trial, neither slot offers Try: one is running, the other is what the next boot is anyway');
  ok(/Commit to partition 1/.test(t) && !/Keep/.test(t), 'the running, uncommitted slot offers Commit to partition 1');
  ok(/Committed/.test(t) && !/Kept/.test(t), 'and the committed slot is badged Committed');
  t = await fwText({ ...trialFW, exe: '/etc/config/confd/confd' });
  ok(/override in \/etc\/config is in use/.test(t), 'a confd run from /etc/config is an override');
  t = await fwText({ ...trialFW, env: { sw_active: '1', sw_commit: '1', sw_tryactive: '2' }, exe: '/bin/confd',
                     slots: { 0: { kernel: 'Linux Kernel Image', built: 1600000000 } } });
  ok(/Try partition 0/.test(t) && !/Try partition 1/.test(t), 'committed, Try is offered on the other slot only');
  t = await fwText({ ...trialFW, env: { sw_active: '1', sw_commit: '1', sw_tryactive: '2' }, exe: '/bin/confd' });
  ok(!/Try partition/.test(t) && /holds no kernel the bootloader would boot/.test(t),
     'a slot with no uImage header gets no Try button, and says why');
  t = await fwText({ ...trialFW, exe: '/bin/confd', dev_confirm_arp: '192.168.1.2', dev_breadcrumbs: true });
  ok(/confirm-arp is set \(address 192\.168\.1\.2\)/.test(t) && /breadcrumbs\.on is present/.test(t),
     'the running slot card carries both notes next to Commit');
  t = await fwText({ ...trialFW, exe: '/bin/confd' });
  ok(!/confirm-arp|breadcrumbs/.test(t), 'and neither without the files');

  /* The Reboot button while a write runs. The follow loop that a running state
     starts is parked: its poll answers and its nap never ends. */
  const fwm = await import(join(root, 'web', 'firmware.js'));
  const rebootBtn = () => {
    let b = null;
    const visit = (n) => { if (n.classList && n.classList.contains('cost-reboot')) b = n; (n.children || []).forEach(visit); };
    visit(doc.querySelector('#parts'));
    return b;
  };
  /* Before the parked loops below, which leave a follow running for good.
     A write started from this page: the button was rendered before it, so it
     is held when the write starts, not only by the next render. */
  const idleFW = { ...trialFW, exe: '/bin/confd' };
  await fwText(idleFW);
  const btn0 = rebootBtn();
  let seen = null;
  const keepGet = fwm.followDeps.get, keepFetch = globalThis.fetch, keepConfirm = globalThis.confirm;
  fwm.followDeps.get = async () => {
    seen = { disabled: btn0.disabled, title: btn0.title };
    return { write: { state: 'ok', slot: '0', rc: '', log: '' } };
  };
  globalThis.confirm = () => true;
  let atPost = null;
  globalThis.fetch = async (path, opts) => {
    if (!(opts && opts.method === 'POST')) return keepFetch(path, opts);
    atPost = { disabled: btn0.disabled, title: btn0.title };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  await fwm.writeImage('0', idleFW);
  for (let i = 0; i < 20 && rebootBtn() === btn0; i++) await new Promise((r) => setTimeout(r, 0));
  fwm.followDeps.get = keepGet; globalThis.fetch = keepFetch; globalThis.confirm = keepConfirm;
  ok(seen && seen.disabled === true && /being written/.test(seen && seen.title),
     'reboot: a write started on this page turns the button off from the start');
  ok(rebootBtn() !== btn0 && !rebootBtn().disabled, 'reboot: and the render after the write turns it on');
  ok(atPost && atPost.disabled === true && /being written/.test(atPost.title),
     'reboot: the button is already off while the write request is pending');
  /* A request that fails or is refused gives the button back. */
  for (const post of [async () => ({ ok: true, json: async () => ({ ok: false, error: 'refused' }) }),
                      async () => { throw new Error('network'); }]) {
    await fwText(idleFW);
    const b1 = rebootBtn();
    globalThis.confirm = () => true;
    globalThis.fetch = async (path, opts) => (opts && opts.method === 'POST' ? post() : keepFetch(path, opts));
    await fwm.writeImage('0', idleFW);
    globalThis.fetch = keepFetch; globalThis.confirm = keepConfirm;
    ok(b1.disabled === false, 'reboot: a write request that is refused or fails leaves the button on');
  }
  /* A writer that is gone with no recorded result: the page says so, and Reboot is not held. */
  await fwText({ ...idleFW, write: { state: 'unknown', pid: '4242', slot: '0', rc: '', log: '' } });
  ok(rebootBtn().disabled === false && /ended without recording a result/.test(textOf(doc.querySelector('#parts'))),
     'reboot: an unknown write result leaves Reboot on and says the writer is gone');

  const keepSleep = fwm.followDeps.sleep;
  fwm.followDeps.sleep = () => new Promise(() => {});
  await fwText({ ...trialFW, exe: '/bin/confd', write: { state: 'running', pid: '4242', slot: '0', rc: '', log: '' } });
  ok(rebootBtn() && rebootBtn().disabled === true && /being written/.test(rebootBtn().title),
     'reboot: the button is off while a write runs, and says why');
  await fwText({ ...trialFW, exe: '/bin/confd', write: { state: 'ok', pid: '4242', slot: '0', rc: '', log: '' } });
  ok(rebootBtn() && !rebootBtn().disabled, 'reboot: and on again once the write is no longer running');
  await fwText({ ...trialFW, exe: '/bin/confd' });
  ok(rebootBtn() && !rebootBtn().disabled, 'reboot: and on when there is no write at all');

  fwm.followDeps.sleep = keepSleep;
  API['/api/firmware'] = keep;
}

/* --- indented continuation lines ----------------------------------------- */
const tod = parseOmci(OMCI[131]).instances[0];
ok(!tod.groups.length, 'ME 131 ToDInfo sub-lines do not become sub-tables');
ok(/Sequence number/.test(attr(tod, 'ToDInfo') || ''),
   'they are folded into the attribute they belong to');

/* The active partition (sw_active=0 in the stub env) holds ODI-260910-...,
   while the captured ME 7 reports V1.0-220923 -- which is exactly the real
   situation on these sticks today: the versioned image has not been flashed.
   The card must say so and name the nv variable that fixes it. */
ok(/is not what the OLT was told/.test(text),
   'a version the active partition does not hold is reported as such');
ok(/OMCI_SW_VER1/.test(text) && /identity switch/.test(text),
   'and the fix names the key and the switch that report it on this image');
ok(!/sw_custom_version/.test(text), 'not the stock-only nv variable');

/* --- this image own settings table --------------------------------------- */
const state = await import(join(root, 'web', 'state.js'));
const { withPairs } = await import(join(root, 'web', 'save.js'));
const { EDITS } = state;
const walk = (n, f) => { f(n); for (const c of n.children || []) walk(c, f); };
/* The editable subtabs, each its own host now that Config is grouped. */
const GROUP_HOSTS = ['line', 'vlan', 'identity', 'expert', 'network', 'services', 'other'].map((g) => '#set-' + g);
const hostsOf = (sel) => (sel === '#common' ? GROUP_HOSTS : [sel]).map((h) => doc.querySelector(h));
const rowsOf = (sel) => {
  const out = [];
  for (const host of hostsOf(sel)) walk(host, (n) => { if (n.classList && n.classList.contains('setting')) out.push(n); });
  return out;
};
const inputsOf = (sel) => {
  let n = 0;
  /* A table editor is one control, however many rows it holds. */
  const count = (x) => {
    if (x.classList && x.classList.contains('fme')) { n++; return; }
    if (x.tagName === 'input' || x.tagName === 'select') n++;
    for (const c of x.children || []) count(c);
  };
  for (const host of hostsOf(sel)) count(host);
  return n;
};
const tagsOf = (sel) => {
  const out = [];
  for (const host of hostsOf(sel)) {
    walk(host, (x) => {
      if (x.tagName === 'span' && x.classList && (x.classList.contains('tag') || x.classList.contains('cost'))) out.push(textOf(x));
    });
  }
  return out;
};
const allText = (sel) => hostsOf(sel).map(textOf).join('\n');

for (const r of SETT) S.SETTINGS[r.name] = r;
S.FW = API['/api/firmware'];
ok(state.imageAware(), 'the settings table makes the page image-aware');
renderAll();
const common = '#common';
ok(rowsOf(common).length === SETT.length,
   `Config shows exactly the ${SETT.length} keys this image reads`);
const classTags = tagsOf(common).filter((t) => Object.values(state.CLASS_LABEL).includes(t));
ok(classTags.length === SETT.length, 'and every one of them carries its apply class');
ok(tagsOf(common).includes('Interrupts internet') && tagsOf(common).includes('Live')
   && tagsOf(common).includes('Reboot'), 'the classes are the ones SETTINGS.md names');
const pairs = SETT.filter((r) => r.pair).length;
ok(inputsOf(common) === SETT.length - pairs,
   'every key is editable except the ones written with another (LOID_OLD)');
const stock = '#sections';
const { OWN_CONTROL } = await import(join(root, 'web', 'config.js'));
ok(rowsOf(stock).length === SCHEMA.length - SETT.length - OWN_CONTROL.length,
   'the stock keys are all on their own tab (the keys with a control of their own are on neither)');
ok(![stock, common].some((v) => /HOST_AUTONEG|Host port auto-negotiation|HOST_SERDES|Host port SerDes mode|Host port link mode/.test(textOf(doc.querySelector(v)))),
   'HOST_AUTONEG and HOST_SERDES are no schema rows: only the Host port control changes them');
ok(inputsOf(stock) === 0, 'and none of them can be edited there');
ok(doc.querySelector('#device-login').hidden === true,
   'the stock device-login section is not offered');

/* The two SERVICE RESTART keys are editable and validate as host[:port]. */
ok(tagsOf(common).includes('Service restart'), 'SYSLOG_SERVER / NTP_SERVER carry SERVICE RESTART');

/* Help text: one line shown, the rest behind Details, and nothing said twice.
   meta.tsv and settings.tsv were written apart, and the page used to print
   the syslog and NTP explanations twice over, and "re-ranges" on every VLAN
   row twice. */
const { splitHelp, GROUPS } = await import(join(root, 'web', 'config.js'));
for (const r of SETT) {
  const m = META.find((x) => x.name === r.name) || {};
  const h = splitHelp(m.help, r.note);
  const said = [h.first, h.rest, h.note].join(' ').split(/(?<=[.!?])\s+/).map((x) => x.toLowerCase().trim()).filter(Boolean);
  ok(new Set(said).size === said.length, `${r.name}: no sentence is shown twice`);
}
ok(splitHelp('One. Two.', 'Two. Three.').note === 'Three.', 'a note sentence already in the help is dropped');
ok(!/[.!?].+[.!?]/.test(splitHelp(META.find((x) => x.name === 'NTP_SERVER').help, '').first),
   'the visible help is one sentence');
const hpRow = { name: 'NTP_SERVER', type: 'hostport' };
const hp = (v) => valueProblem(hpRow, v);
ok(!hp('pool.ntp.org') && !hp('10.0.0.1') && !hp('10.0.0.1:514') && !hp('a-b.c:65535'),
   'hostport accepts hostnames, IPv4 literals and host:port');
ok(['a b', 'a"b', "a'b", 'h:0', 'h:70000', 'h:', ':1', '-h', 'h.'].every((v) => hp(v)),
   'hostport rejects spaces, quotes and bad ports');
ok(!hp(''), 'hostport accepts empty: it clears the key');
const hwv = (v) => valueProblem({ name: 'ONU_HW_VERSION', type: 'ascii14' }, v);
ok(!hwv('HW-2.1') && !hwv('12345678901234') && !hwv(''),
   'ascii14 accepts up to 14 printable characters, and empty (it clears the key)');
ok(['123456789012345', 'a"b', 'a<b', 'a&b', 'caf\u00e9', 'a\tb'].every((v) => hwv(v)),
   'ascii14 rejects 15 characters, a quote, < and &, and anything outside printable ASCII');
/* Types chosen by what reads the key: the page and the daemon (src/mib.c) agree. */
const vp = (type, v) => valueProblem({ name: 'X', type }, v);
ok(['10.20.30.1', '192.168.100.1', '1.0.0.1', '223.255.255.254'].every((v) => !vp('ipv4host', v)),
   'ipv4host accepts addresses the kernel takes');
ok(['0.0.0.0', '127.0.0.1', '224.0.0.1', '255.255.255.255', '192.168.010.1', '192.168.1', '1.2.3.4.5', '256.1.1.1']
  .every((v) => vp('ipv4host', v)), 'ipv4host rejects 0/8, loopback, multicast, broadcast, leading zeros and malformed');
/* The address and its netmask are judged together (src/mib.c lan_pair_refusal,
   network.sh valid_host): the same values are accepted and refused. */
{
  const { S: St, EDITS: Ed } = await import(join(root, 'web', 'state.js'));
  const addr = (v, name = 'LAN_IP_ADDR') => valueProblem({ name, type: 'ipv4host' }, v);
  const mask = (v, name = 'LAN_SUBNET') => valueProblem({ name, type: 'netmask' }, v);
  const keep = St.VALUES;
  St.VALUES = {};
  Ed.clear();
  ok(['192.168.1.0', '192.168.1.255', '10.0.0.0', '10.255.255.255'].every((v) => /network or broadcast/.test(addr(v))),
     'with no stored netmask the address is judged on a /24: network and broadcast are refused');
  ok(['192.168.1.1', '192.168.1.254', '10.0.0.1'].every((v) => !addr(v)), 'and its neighbours are accepted');
  ok(/network or broadcast/.test(addr('192.168.100.255', 'LAN_IP_ADDR2')) && !addr('192.168.100.1', 'LAN_IP_ADDR2'),
     'the second address is held to the same rule');
  St.VALUES = { LAN_SUBNET: '255.255.254.0', LAN_IP_ADDR: '192.168.0.0' };
  ok(/network or broadcast/.test(addr('192.168.1.255')) && !addr('192.168.1.0') && /network or broadcast/.test(addr('192.168.0.0')),
     'against the stored /23: 192.168.1.255 and 192.168.0.0 are refused, 192.168.1.0 is a host');
  ok(/netmask that makes/.test(mask('255.255.254.0')) && !mask('255.0.0.0'),
     'a netmask is judged against the stored address: the /23 makes 192.168.0.0 a network address, a /8 does not');
  Ed.set('LAN_SUBNET', '255.255.255.252');
  ok(/network or broadcast/.test(addr('192.168.1.7')) && /network or broadcast/.test(addr('192.168.1.4')) && !addr('192.168.1.5'),
     'a pending netmask edit counts: on a /30, .4 and .7 are refused, .5 is a host');
  Ed.clear();
  St.VALUES = { LAN_SUBNET: '255.0.255.0' };
  ok(!addr('192.168.1.255'), 'an unusable stored netmask is not this check (it has its own message)');
  St.VALUES = keep;
}
ok(['255.255.255.0', '255.0.0.0', '255.255.255.252', '255.255.128.0'].every((v) => !vp('netmask', v)),
   'netmask accepts ones then zeros from /8 to /30');
ok(['255.0.255.0', '0.0.0.0', '255.255.255.255', '255.255.255.254', '254.0.0.0', '255.255.255.1', '255.255.255.00']
  .every((v) => vp('netmask', v)), 'netmask rejects a gap in the ones, /0, /31, /32, shorter than /8 and leading zeros');
ok(!vp('gponsn', 'ODI0123456aB') && !vp('gponsn', 'TMBB0077D9B9'), 'gponsn accepts four characters and eight hex digits');
ok(['ODI12345678', 'ODI0123456789', 'ODI01234567G', 'OD 012345678', 'ODI"01234567', ''].every((v) => vp('gponsn', v)),
   'gponsn rejects 11 and 13 characters, a non-hex serial, a space and a quote');
{
  /* The serial number as 16 hex digits, a modem ID, and the way back. */
  const { snFromHex, snToHex } = await import(join(root, 'web', 'validate.js'));
  ok(snFromHex('4F44495800000009') === 'ODIX00000009' && snFromHex('4f44 4958-0000:00a9') === 'ODIX000000a9'
     && snFromHex(' 4F44.4958 0000 0009 ') === 'ODIX00000009',
     'serial in hex: 16 hex digits become four characters and eight digits, with or without separators');
  ok([' ', 'ODIX00000009', '4F4449580000000', '4F444958000000090', '4F44495800000g09', '0044495800000009',
      '4F44492000000009', '4F44492200000009', '4F44493C00000009', '4F44492600000009', '4F44497F00000009']
    .every((v) => snFromHex(v) === null),
     'serial in hex: not 16 hex digits, or a vendor id that is not four storable characters, is left alone');
  ok(snToHex('ODIX000000a9') === '4F444958000000A9' && snToHex('ODIX0000000') === null && snToHex('') === null
     && snFromHex(snToHex('TMBB0077D9B9')) === 'TMBB0077D9B9',
     'serial in hex: the stored form reads back as 16 hex digits, and round-trips');
  ok(/first eight/.test(vp('gponsn', '0044495800000009')) && /12 in all/.test(vp('gponsn', '4F4449580000000'))
     && !vp('gponsn', snFromHex('4F44495800000009')),
     'serial in hex: 16 digits with an unprintable vendor id say so, 15 get the usual message');
}
ok(!vp('hex20', '31323334353637383930'), 'hex20 accepts 20 hex digits');
ok(['3132333435363738393', '313233343536373839303132', '1234', 'zz323334353637383930'].every((v) => vp('hex20', v)),
   'hex20 rejects odd, longer, shorter and non-hex values (the kernel would read a shorter one as text)');
ok(!vp('str14', 'V1.1.6-2402021') && vp('str14', 'V1.1.6-24020212') && vp('str14', 'a"b') && vp('str14', 'caf\u00e9'),
   'strN accepts up to N printable characters and rejects one more, a quote and non-ASCII');
ok(!vp('elanmac', '023a21282716') && vp('elanmac', '010203040506') && vp('elanmac', '000000000000') && vp('elanmac', '0102030405'),
   'elanmac rejects a multicast and an all-zero address');
ok(!vp('mac', '023a21282716') && !vp('mac', '010203040506') && !vp('mac', '000000000000') && vp('mac', '0102030405'),
   'mac is plain 12 hex digits: HW_SERIAL_NO and WLAN_MAC_ADDR are not held to the unicast rule');
ok(S.SCHEMA.find((r) => r.name === 'ELAN_MAC_ADDR').type === 'elanmac'
   && S.SCHEMA.find((r) => r.name === 'HW_SERIAL_NO').type === 'mac', 'only ELAN_MAC_ADDR has the unicast type');
ok(['LAN_IP_ADDR', 'LAN_IP_ADDR2'].every((n) => S.SCHEMA.find((r) => r.name === n).type === 'ipv4host')
   && ['LAN_SUBNET', 'LAN_SUBNET2'].every((n) => S.SCHEMA.find((r) => r.name === n).type === 'netmask')
   && S.SCHEMA.find((r) => r.name === 'GPON_SN').type === 'gponsn'
   && S.SCHEMA.find((r) => r.name === 'GPON_PLOAM_PASSWD').type === 'hex20',
   'the schema gives the address, mask, serial number and PLOAM keys their checks');
const fwd = (v) => valueProblem({ name: 'RTK_DEVINFO_SPECVER', type: 'fwdop' }, v);
ok(!fwd('') && !fwd('0x1102:0x00') && !fwd('0x1102:0x00,0x110b') && !fwd('4354:0, 4363:16')
   && !fwd(Array.from({ length: 12 }, (_, i) => `${i}:0x02`).join(',')),
   'fwdop accepts empty, ENTITY and ENTITY:FWDOP in decimal or 0x hex, either separator, twelve entries');
ok(['0x1102:0x100', '0x10000', '65536', '0x1102:', 'zz', '0x1102:0x00:1', '0x1102,4354', '1:256',
  Array.from({ length: 13 }, (_, i) => `${i}`).join(',')].every((v) => fwd(v)),
   'fwdop rejects a code past 0xff, an entity past 65535, an empty code, text, a third field, an entity twice and 13 entries');
ok(S.SCHEMA.find((r) => r.name === 'RTK_DEVINFO_SPECVER').type === 'fwdop',
   'the schema gives RTK_DEVINFO_SPECVER the fwdop check');
const fme = (v) => valueProblem({ name: 'OMCI_FIXED_ME', type: 'fixedme' }, v);
ok(!fme('200:0x0011aa') && !fme('200:0x0011aa,201:01020304') && !fme('1:aa 65535:0XAB, 7:'+'ff'.repeat(25)) && !fme(''),
   'fixedme accepts one or more CLASS:HEX entries, either separator, and empty (it clears the key)');
ok(['0:aa', '65536:aa', '200aa', '200:abc', '200:zz', '200:0x', '200:aa,200:bb', '200:' + 'ff'.repeat(26),
  ',200:aa', '200:aa,', ...Array(1).fill(Array.from({ length: 17 }, (_, i) => `${i + 1}:aa`).join(','))].every((v) => fme(v)),
   'fixedme rejects class 0 and 65536, a missing colon, odd digits, non-hex, 26 bytes, a duplicate class and 17 entries');
ok(!fme(Array.from({ length: 16 }, (_, i) => `${i + 1}:aa`).join(',')), 'fixedme accepts sixteen entries');
ok(!fme('188:0x8001:1:0x0011aa') && !fme('188:32769:1:00,188:0x8001:2:ff 188:0xFFFF:16:' + 'ab'.repeat(25))
   && !fme('188:0:1:00,200:aa') && !fme('188:1:1:00 188:1:2:00 188:2:1:00'),
   'fixedme accepts CLASS:INSTANCE:ATTR:HEX, decimal or 0x instance, several attributes, and both forms on different classes');
ok(['188:0x8001:0:00', '188:0x8001:17:00', '188:0x8001:001:00x', '188:0x10000:1:00', '188:65536:1:00',
  '188:0x:1:00', '188:-1:1:00', '188:1:1', '188::1:00', '188:1::00', '188:1:2:3:00', '0xbc:1:1:00',
  '188:1:1:0', '188:1:1:0x', '188:1:1:' + 'ff'.repeat(26),
  '188:1:1:00,188:0x1:1:01', '188:0x8001:1:00 188:32769:1:01',   /* the same slot twice, spelled two ways */
  '188:00,188:1:1:00', '188:1:1:00,188:00']   /* a class in both forms, either order */
  .every((v) => fme(v)),
  'fixedme rejects attribute 0 and 17, an instance past 65535, a missing field, a slot twice and a class in both forms');
{
  const rows = fixedMeParse('200:0011aa,188:0x8001:1:ff');
  ok(rows.length === 2 && rows[0].inst === 'any' && rows[0].attr === 'any' && rows[0].hex === '0011aa'
     && rows[1].cls === '188' && rows[1].inst === '0x8001' && rows[1].attr === '1' && rows[1].hex === 'ff',
     'fixedMeParse: the legacy form reads as any/any, the entry form as typed');
  ok(fixedMeSerialise(rows) === '200:0011aa,188:0x8001:1:ff', 'fixedMeSerialise: the round trip keeps the text');
  ok(fixedMeSerialise([{ cls: '', inst: '', attr: '', hex: '' }, { cls: '5', inst: 'any', attr: '', hex: 'aa' }]) === '5:aa',
     'fixedMeSerialise: an empty row is dropped, any/empty is the legacy form');
  ok(fme(fixedMeSerialise([{ cls: '5', inst: '1', attr: '', hex: 'aa' }])), 'an unfinished row serialises to a string the check refuses');
  ok(fixedMeRowProblems({ cls: '0', inst: 'x', attr: '3', hex: 'a' }).cls && fixedMeRowProblems({ cls: '0', inst: 'x', attr: '3', hex: 'a' }).inst
     && fixedMeRowProblems({ cls: '0', inst: 'x', attr: '3', hex: 'a' }).hex && !fixedMeRowProblems({ cls: '5', inst: 'any', attr: '', hex: 'aa' }).inst,
     'fixedMeRowProblems names the fields that are wrong');
  /* The editor: one table row per entry, and a row it adds. */
  const ed = renderFixedMeEditor('200:0011aa,188:0x8001:1:ff', () => {});
  const trs = ed.tableLine.children[0].children[1].children;
  ok(trs.length === 2 && trs[0].inputs.map((i) => i.value).join('|') === '200|any|any|0011aa'
     && trs[1].inputs.map((i) => i.value).join('|') === '188|0x8001|1|ff',
     'the expert editor shows one row per entry, the legacy form as any/any');
  let seen = null;
  const ed2 = renderFixedMeEditor('', (v) => { seen = v; });
  ok(ed2.tableLine.children[0].children[1].children.length === 0, 'the expert editor with no value has no rows');
  ed2.children[2].onclick();
  const row0 = ed2.tableLine.children[0].children[1].children[0];
  row0.inputs[0].value = '188'; row0.inputs[0].oninput();
  ok(seen === '188:', 'a half-typed row is handed on as typed, so the check holds the save');
  row0.inputs[1].value = '0x8001'; row0.inputs[1].oninput();
  row0.inputs[2].value = '1'; row0.inputs[2].oninput();
  row0.inputs[3].value = '0011aa'; row0.inputs[3].oninput();
  ok(seen === '188:0x8001:1:0011aa' && !fme(seen), 'a finished row serialises to the entry form');
  ed2.children[2].onclick();
  const r1 = ed2.tableLine.children[0].children[1].children[1];
  r1.inputs[0].value = '188'; r1.inputs[0].oninput();
  r1.inputs[3].value = '00'; r1.inputs[3].oninput();
  ok(fme(seen) && /both forms/.test(fme(seen)), 'a legacy row for a class that has an entity says both forms');
  r1.children[4].children[0].onclick();
  ok(seen === '188:0x8001:1:0011aa', 'removing a row removes its entry');
}

/* --- LAN_ROUTES: the static routes of the management interface ------------- */
{
  const V = await import(join(root, 'web', 'validate.js'));
  const { renderRoutesEditor } = await import(join(root, 'web', 'lanroutes.js'));
  const stock = { get: (k) => ({ LAN_IP_ADDR: '192.168.1.1', LAN_SUBNET: '255.255.255.0' })[k] };
  const rtp = (v, ctx = stock) => V.valueProblem({ name: 'LAN_ROUTES', type: 'routes' }, v, ctx);
  const two = 'default via 192.168.1.254,10.0.0.0/8 via 192.168.1.3';
  ok(S.SCHEMA.find((r) => r.name === 'LAN_ROUTES').type === 'routes', 'the schema gives LAN_ROUTES the routes check');
  /* parse and serialise */
  ok(JSON.stringify(V.routesParse('  default   via  192.168.1.254 ,  10.0.0.0/8 via 192.168.1.3 '))
     === JSON.stringify([{ dest: 'default', gw: '192.168.1.254' }, { dest: '10.0.0.0/8', gw: '192.168.1.3' }]),
     'routes: extra spaces around words and commas are read');
  ok(V.routesSerialise(V.routesParse('default via 192.168.1.254, 10.0.0.0/8   via 192.168.1.3')) === two,
     'routes: the serialised form is canonical, DEST via GW joined by a bare comma');
  ok(V.routesParse('').length === 0 && V.routesSerialise([]) === '' && V.routesSerialise([{ dest: '', gw: '' }]) === '',
     'routes: empty is no rows and no rows is empty');
  ok(V.routesSerialise([{ dest: '10.0.0.0/8', gw: '' }]) === '10.0.0.0/8 via ' && rtp('10.0.0.0/8 via '),
     'routes: an unfinished row goes out as typed and the check refuses it');
  ok(V.routesParse('10.0.0.0/8')[0].dest === '10.0.0.0/8' && V.routesParse('10.0.0.0/8')[0].gw === '',
     'routes: an entry that is not DEST via GW keeps its text');
  /* rows */
  const rp = V.routeRowProblems;
  ok(!rp({ dest: 'default', gw: '192.168.1.254' }).dest && !rp({ dest: '0.0.0.0/0', gw: '1.1.1.1' }).dest
     && !rp({ dest: '10.1.2.3/32', gw: '1.1.1.1' }).dest, 'routes: default, /0 and /32 destinations are fine');
  ok(/host bits/.test(rp({ dest: '10.0.0.1/8', gw: '1.1.1.1' }).dest) && /10\.0\.0\.0\/8/.test(rp({ dest: '10.0.0.1/8', gw: '1.1.1.1' }).dest),
     'routes: host bits in the destination say which network it is');
  ok(['10.0.0.0', '10.0.0.0/33', '10.0.0.0/', '10.0.0.0/08', 'Default', '999.0.0.0/8', ''].every((d) => rp({ dest: d, gw: '1.1.1.1' }).dest),
     'routes: no prefix, a prefix past 32, a leading zero, other spelling and a bad octet are refused');
  ok(rp({ dest: 'default', gw: '1.2.3.999' }).gw && rp({ dest: 'default', gw: '' }).gw && !rp({ dest: 'default', gw: '1.2.3.4' }).gw,
     'routes: a gateway is an IPv4 address');
  /* sets */
  ok(V.routesSetProblem([{ dest: 'default' }, { dest: '0.0.0.0/0' }]) && V.routesSetProblem([{ dest: '10.0.0.0/8' }, { dest: '10.0.0.0/8' }])
     && !V.routesSetProblem([{ dest: '10.0.0.0/8' }, { dest: '10.0.0.0/16' }]),
     'routes: a destination twice is refused, default and 0.0.0.0/0 being one, but two prefixes of one network are fine');
  ok(V.routesSetProblem(Array.from({ length: 9 }, (_, i) => ({ dest: `10.${i}.0.0/16` }))) && !V.routesSetProblem(Array.from({ length: 8 }, (_, i) => ({ dest: `10.${i}.0.0/16` }))),
     'routes: eight at most');
  /* gateways against the management subnets */
  ok(/stick itself/.test(rtp('default via 192.168.1.1')) && /network or broadcast/.test(rtp('default via 192.168.1.255'))
     && /network or broadcast/.test(rtp('default via 192.168.1.0')), 'routes: the address of the stick and the network and broadcast addresses are not gateways');
  ok(rtp('') === null && rtp(two) === null && rtp('default via 192.168.1.254, 10.0.0.0/8 via 192.168.1.3') === null,
     'routes: empty, and entries with the gateway on the first subnet, are fine (a space after the comma too)');
  ok(/not inside 192\.168\.1\.0\/24/.test(rtp('default via 10.9.9.9')), 'routes: a gateway outside the subnet says which subnet');
  const second = { get: (k) => ({ LAN_IP_ADDR: '192.168.1.1', LAN_SUBNET: '255.255.255.0', LAN_ENABLE_IP2: '1',
    LAN_IP_ADDR2: '172.20.0.1', LAN_SUBNET2: '255.255.0.0' })[k] };
  ok(rtp('default via 172.20.9.9', second) === null && rtp('default via 192.168.1.9', second) === null
     && /or 172\.20\.0\.0\/16/.test(rtp('default via 10.9.9.9', second)),
     'routes: the second subnet counts while the second address is on');
  ok(/not inside/.test(rtp('default via 172.20.9.9', { get: (k) => ({ ...Object.fromEntries(['LAN_IP_ADDR', 'LAN_SUBNET'].map((n) => [n, stock.get(n)])),
    LAN_ENABLE_IP2: '0', LAN_IP_ADDR2: '172.20.0.1' })[k] })), 'routes: the second subnet does not count while the second address is off');
  ok(rtp('default via 10.9.9.9', { get: () => '1' }) === null, 'routes: while an address is not usable yet the gateway is not judged');
  /* an address edit that leaves a stored gateway outside */
  const held = { get: (k) => ({ LAN_IP_ADDR: '192.168.1.1', LAN_SUBNET: '255.255.255.0', LAN_ROUTES: two })[k] };
  ok(/change the static routes/.test(V.keyRuleProblem('LAN_IP_ADDR', '10.1.1.1', held)) && V.keyRuleProblem('LAN_IP_ADDR', '192.168.1.5', held) === null
     && /change the static routes/.test(V.keyRuleProblem('LAN_SUBNET', '255.255.255.128', { get: (k) => (k === 'LAN_IP_ADDR' ? '192.168.1.1' : held.get(k)) })),
     'routes: an address or netmask change that leaves a stored gateway outside is refused until the routes change with it');
  /* the editor */
  const ed = renderRoutesEditor(two, () => {});
  const body = ed.tableLine.children[0].children[1];
  ok(body.children.length === 2 && body.children[0].inputs.map((i) => i.value).join('|') === 'default|192.168.1.254'
     && body.children[1].inputs.map((i) => i.value).join('|') === '10.0.0.0/8|192.168.1.3', 'routes editor: one row per route');
  const none = renderRoutesEditor('', () => {});
  ok(none.tableLine.children[0].children[1].children.length === 0 && /No static routes/.test(JSON.stringify(none.children[1])),
     'routes editor: with no value there are no rows, and a line says what routes are for');
  let seen = null;
  const ed3 = renderRoutesEditor('', (v) => { seen = v; });
  ed3.children[2].onclick();
  const r0 = ed3.tableLine.children[0].children[1].children[0];
  r0.inputs[0].value = ' 10.0.0.0/8 '; r0.inputs[0].oninput();
  ok(seen === '10.0.0.0/8 via ' && rtp(seen), 'routes editor: a half-typed row is handed on as typed, so the check holds the save');
  r0.inputs[1].value = '192.168.1.3'; r0.inputs[1].oninput();
  ok(seen === '10.0.0.0/8 via 192.168.1.3' && rtp(seen) === null, 'routes editor: a finished row serialises to the entry form');
  r0.inputs[0].value = '10.0.0.1/8'; r0.inputs[0].oninput();
  ok(/host bits/.test(JSON.stringify(ed3.children[1])) && r0.inputs[0].classList.contains('invalid'),
     'routes editor: an error is written under the table and the field is marked');
  r0.inputs[0].value = 'default'; r0.inputs[0].oninput();
  ed3.children[2].onclick();
  const r1b = ed3.tableLine.children[0].children[1].children[1];
  r1b.inputs[0].value = '0.0.0.0/0'; r1b.inputs[0].oninput();
  r1b.inputs[1].value = '192.168.1.2'; r1b.inputs[1].oninput();
  ok(/listed twice/.test(JSON.stringify(ed3.children[1])), 'routes editor: default and 0.0.0.0/0 together say the destination is listed twice');
  r1b.children[2].children[0].onclick();
  ok(seen === 'default via 192.168.1.3' && !/listed twice/.test(JSON.stringify(ed3.children[1])), 'routes editor: removing a row removes its route');
  for (let i = 0; i < 7; i++) ed3.children[2].onclick();
  ok(ed3.children[2].disabled === true && ed3.tableLine.children[0].children[1].children.length === 8, 'routes editor: Add is off at eight rows');
}
{
  const setting = (n) => SETT.find((r) => r.name === n);
  ok(['VLAN_CFG_TYPE', 'VLAN_MANU_MODE', 'VLAN_MANU_TAG_VID', 'VLAN_MANU_TAG_PRI']
    .every((n) => setting(n) && setting(n).apply === 'live' && setting(n).action === 'omci'),
  'the four VLAN keys are live and applied by omci');
  ok(setting('OLT_SW_DOWNLOAD').apply === 'live' && setting('OLT_SW_DOWNLOAD').action === 'none',
    'OLT_SW_DOWNLOAD is live with nothing to apply');
  ok(setting('OMCI_ACCEPT_REBOOT').apply === 'live' && setting('OMCI_ACCEPT_REBOOT').action === 'none',
    'OMCI_ACCEPT_REBOOT is live with nothing to apply');
  ok(['ONU_HW_VERSION', 'OMCI_UNKNOWN_ME_OK', 'OMCI_FIXED_ME', 'GPON_SN'].every((n) => setting(n).apply === 'internet' && setting(n).action === 'omci'),
    'the hardware version, unknown-entity answers and serial number re-register the ONU');
  /* A value that can cut the service says so in its own label, and the
     one that cannot does not: the choice is made in the dropdown, where the
     help text is not. */
  const opts = (n) => Object.fromEntries(META.find((x) => x.name === n).options.split('|')
    .map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  const cuts = /service stops unless the router tags/;
  const mode = opts('VLAN_MANU_MODE');
  ok(META.find((x) => x.name === 'VLAN_MANU_MODE').options.split('|').map((p) => p[0]).join(',') === '1,0'
     && /Stick tags/.test(mode[1]) && /Router tags \(transparent\)/.test(mode[0]),
    'VLAN_MANU_MODE offers stick tags and router tags (transparent)');
  ok(cuts.test(mode[0]) && !cuts.test(mode[1]),
    'VLAN_MANU_MODE: router tags says the service stops unless the router tags, stick tags does not');
  const type = opts('VLAN_CFG_TYPE');
  ok(cuts.test(type[0]) && !cuts.test(type[1]),
    'VLAN_CFG_TYPE: transparent says the service stops unless the router tags, manual does not');
  ok(/silently missing/.test(opts('OMCI_UNKNOWN_ME_OK')[1]) && !/missing/.test(opts('OMCI_UNKNOWN_ME_OK')[0]),
    'OMCI_UNKNOWN_ME_OK: on names its risk in the label, off does not');
  ok(Object.values(opts('OLT_SW_DOWNLOAD')).every((l) => /service is not touched/.test(l)),
    'OLT_SW_DOWNLOAD: both values say the service is not touched');
  ok(/removes it at once/.test(opts('LAN_ENABLE_IP2')[0]),
    'LAN_ENABLE_IP2: off says the address goes at once');
  /* The first sentence is the one shown without opening Details. */
  const first = (n) => splitHelp(META.find((x) => x.name === n).help,
    (SETT.find((r) => r.name === n) || {}).note).first;
  for (const [n, re] of [['VLAN_CFG_TYPE', /service then stops/], ['VLAN_MANU_MODE', /service stops/],
    ['VLAN_MANU_TAG_VID', /stops the service at once/], ['GPON_SN', /no service/],
    ['GPON_PLOAM_PASSWD', /refuses the ONU/], ['LOID', /refuses the ONU/]]) {
    ok(re.test(first(n)), `${n}: the visible help says how a value can cut the service`);
  }
  ok(['ONU_HW_VERSION', 'OLT_SW_DOWNLOAD', 'OMCI_ACCEPT_REBOOT'].every((n) => GROUPS.identity.includes(n)),
    'the new OLT-facing keys sit on the ONU identity subtab');
  ok(GROUPS.expert.join() === 'OMCI_UNKNOWN_ME_OK,OMCI_FIXED_ME,OMCI_VEIP,OMCI_VEIP_SLOT_ID,OMCI_PRIVATE_ME,OMCI_POTS_PORTS,OMCI_POTS_SLOT_ID,OMCI_VOIP_LINE_REPORT'
     && !GROUPS.identity.includes('OMCI_FIXED_ME') && !GROUPS.identity.includes('OMCI_UNKNOWN_ME_OK'),
    'the unknown-entity, fixed-entity, VEIP and vendor-private keys are expert settings, not in the ONU identity list');
  ok(['OMCI_VEIP', 'OMCI_VEIP_SLOT_ID', 'OMCI_PRIVATE_ME'].every((n) => setting(n).apply === 'internet' && setting(n).action === 'omci'),
    'the VEIP, VEIP slot and vendor-private keys re-register the ONU');
  ok(setting('OMCI_VEIP').unset === '1' && setting('OMCI_PRIVATE_ME').unset === '1',
    'the VEIP and the vendor-private entities are created while the key is unset');
  const veipOpts = META.find((x) => x.name === 'OMCI_VEIP').options.split('|').map((p) => p[0]).join(',');
  ok(veipOpts === '1,0' && /PPTP-only/.test(opts('OMCI_VEIP')[0]),
    'OMCI_VEIP offers create and none, and none says what it means');
  ok(META.find((x) => x.name === 'OMCI_VEIP_SLOT_ID').range === '2-254',
    'OMCI_VEIP_SLOT_ID takes a slot of 2 to 254');
}

EDITS.set('LOID', 'someone');
const pw = withPairs([...EDITS.entries()]);
ok(pw.some(([k, v]) => k === 'LOID_OLD' && v === 'someone'),
   'saving LOID writes LOID_OLD too, since the OLD value wins');
EDITS.clear();

/* The VLAN keys are LIVE, so a value that stops the traffic is asked about
   before the save, not after it: the ONU stays in O5 and nothing else would
   say so. */
{
  const { vlanRisk } = state;
  const base = { VLAN_CFG_TYPE: '1', VLAN_MANU_MODE: '1', VLAN_MANU_TAG_VID: '11', VLAN_MANU_TAG_PRI: '0' };
  ok(/stops tagging VLAN 11/.test(vlanRisk(base, { ...base, VLAN_MANU_MODE: '0' }) || ''),
     'vlanRisk: router tags stops the stick tagging VLAN 11');
  ok(/stops tagging VLAN 11/.test(vlanRisk(base, { ...base, VLAN_CFG_TYPE: '0' }) || ''),
     'vlanRisk: config mode 0 does the same');
  ok(/VLAN 12 instead of 11/.test(vlanRisk(base, { ...base, VLAN_MANU_TAG_VID: '12' }) || ''),
     'vlanRisk: another VLAN ID says which one replaces which');
  ok(/starts tagging untagged frames with VLAN 11/.test(
       vlanRisk({ ...base, VLAN_MANU_MODE: '0' }, base) || ''),
     'vlanRisk: turning tagging on names the VLAN');
  ok(vlanRisk(base, { ...base, VLAN_MANU_TAG_PRI: '3' }) === null && vlanRisk(base, base) === null,
     'vlanRisk: a priority change, or no change, asks nothing');

  const { save, refreshSaveBar, followUp } = await import(join(root, 'web', 'save.js'));
  const realFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (path, opts) => {
    if (opts && opts.method === 'POST') posts.push([String(path), String(opts.body)]);
    return realFetch(path, opts);
  };
  const asked = [];
  globalThis.confirm = (t) => { asked.push(t); return false; };
  EDITS.set('VLAN_MANU_MODE', '0');
  refreshSaveBar();
  await save();
  ok(asked.length === 1 && /stops tagging VLAN 1\b/.test(asked[0]) && /^\u25AE Live/.test(asked[0]),
     'save: router tags asks first, as a Live change that stops the tagging');
  ok(posts.length === 0 && /Not saved/.test(textOf(doc.querySelector('#saveout'))),
     'save: declined, nothing is written');
  globalThis.confirm = (t) => { asked.push(t); return true; };
  await save();
  ok(posts.some(([p, b]) => p === '/api/config' && /VLAN_MANU_MODE=0/.test(b)),
     'save: accepted, the change is written');
  EDITS.clear();
  globalThis.fetch = realFetch;
  globalThis.confirm = () => false;

  /* A key the firmware ignores is shown, not offered, and says why; choosing
     the mode that reads it unlocks it before anything is saved. */
  {
    const { invalidEdits } = await import(join(root, 'web', 'validate.js'));
    const field = (name) => {
      let f = null;
      walk(doc.querySelector('#set-vlan'), (x) => {
        if ((x.tagName === 'input' || x.tagName === 'select') && x.dataset && x.dataset.name === name) f = x;
      });
      return f;
    };
    const vidRow = () => rowsOf('#set-vlan').find((r) => r.dataset.name === 'VLAN_MANU_TAG_VID');
    renderAll();
    {
      /* The serial number field takes a modem ID and shows the stored form. */
      let sn = null;
      let aside = null;
      walk(doc.querySelector('#set-line'), (x) => {
        if (x.tagName === 'input' && x.dataset && x.dataset.name === 'GPON_SN') sn = x;
      });
      const find = () => {
        walk(doc.querySelector('#set-line'), (x) => {
          if (x.children && x.children.includes(sn)) aside = x.children.find((c) => c.className === 's-aside');
        });
        return textOf(aside);
      };
      const was = sn.value;
      sn.value = 'ODIX00000001';
      sn.oninput();
      ok(find() === 'In hex: 4F44495800000001', 'serial field: the serial is shown in hex under the field');
      sn.value = '4f44 4958 0000 00a9';
      sn.oninput();
      ok(sn.value === 'ODIX000000a9' && EDITS.get('GPON_SN') === 'ODIX000000a9' && find() === 'In hex: 4F444958000000A9'
         && !sn.classList.contains('invalid'),
         'serial field: 16 hex digits are converted in the field, and the converted form is the pending edit');
      sn.value = 'ODIX0000';
      sn.oninput();
      ok(/modem ID/.test(find()), 'serial field: an unfinished serial shows the hint instead');
      sn.value = was;
      sn.oninput();
      ok(!EDITS.has('GPON_SN'), 'serial field: back to the stored value, nothing is pending');
    }
    ok(field('VLAN_MANU_TAG_VID') !== null, 'gated: the VLAN ID is editable in manual mode');
    EDITS.set('VLAN_MANU_TAG_VID', '100');
    const mode = field('VLAN_CFG_TYPE');
    mode.value = '0';
    mode.oninput();
    ok(field('VLAN_MANU_TAG_VID') === null && /Not editable now/.test(textOf(vidRow()))
       && /VLAN_CFG_TYPE=1/.test(textOf(vidRow())),
       'gated: config mode 0 locks the VLAN ID and names the key that unlocks it');
    ok(/Not used in this mode/.test(textOf(vidRow())) && /Stored/.test(textOf(vidRow())),
       'gated: and shows no value in the field, only under Details');
    ok(!EDITS.has('VLAN_MANU_TAG_VID'), 'gated: and drops the VLAN ID edit made before');
    {
      const eapRow = rowsOf('#set-vlan').find((r) => r.dataset.name === 'VLAN_EAPOL_UNTAGGED');
      ok(field('VLAN_EAPOL_UNTAGGED') === null && eapRow && /Not editable now/.test(textOf(eapRow))
         && /VLAN_CFG_TYPE=1/.test(textOf(eapRow)),
         'gated: config mode 0 locks the EAPOL switch too, beside the VLAN ID');
    }
    field('VLAN_CFG_TYPE').value = '1';
    field('VLAN_CFG_TYPE').oninput();
    ok(field('VLAN_MANU_TAG_VID') !== null && !EDITS.has('VLAN_CFG_TYPE'),
       'gated: setting mode 1 back unlocks it, with nothing pending');
    ok(field('VLAN_EAPOL_UNTAGGED') !== null && field('VLAN_EAPOL_UNTAGGED').tagName === 'select',
       'gated: and the EAPOL switch is a choice again');
    EDITS.set('VLAN_CFG_TYPE', '0');
    EDITS.set('VLAN_MANU_TAG_VID', '100');
    ok(invalidEdits().some(([k, why]) => k === 'VLAN_MANU_TAG_VID' && /ignored by the firmware/.test(why)),
       'gated: Save refuses a leftover edit to an ignored key');
    EDITS.clear();
    renderAll();
  }

  /* The FwdOp override leaves the attribute as the OLT wrote it, so the OMCI
     tab still shows the old code: the row says so once a value is stored. */
  {
    const fwdRow = () => rowsOf('#set-vlan').find((r) => r.dataset.name === 'RTK_DEVINFO_SPECVER');
    const before = S.VALUES.RTK_DEVINFO_SPECVER;
    S.VALUES.RTK_DEVINFO_SPECVER = '';
    renderAll();
    ok(fwdRow() && !/keep showing the FwdOp/.test(textOf(fwdRow())), 'FwdOp override: no note while the key is empty');
    S.VALUES.RTK_DEVINFO_SPECVER = '0x1102:0x00,0x110b:0x00';
    renderAll();
    ok(fwdRow() && /keep showing the FwdOp the OLT set/.test(textOf(fwdRow())) && /omcli vlan over ssh/.test(textOf(fwdRow()))
       && /pon\/omcli_vlan\.txt in the diagnostics bundle/.test(textOf(fwdRow())) && !/stays 0x10/.test(textOf(fwdRow())),
       'FwdOp override: with a value stored the row says the MIB still shows the OLT code, and both ways to check');
    if (before === undefined) delete S.VALUES.RTK_DEVINFO_SPECVER; else S.VALUES.RTK_DEVINFO_SPECVER = before;
    renderAll();
  }

  /* OMCI_VEIP_SLOT_ID does nothing without bit 256 of OMCI_CUSTOM_ME, which
     the page cannot edit: the row says so, and says what to run. */
  {
    const slotRow = () => rowsOf('#set-expert').find((r) => r.dataset.name === 'OMCI_VEIP_SLOT_ID');
    S.VALUES.OMCI_CUSTOM_ME = '65536';
    renderAll();
    ok(slotRow() && /Has no effect yet/.test(textOf(slotRow())) && /flash set OMCI_CUSTOM_ME 65792/.test(textOf(slotRow())),
       'VEIP slot: without bit 256 the row says it does nothing and gives the value to set');
    S.VALUES.OMCI_CUSTOM_ME = '65792';
    renderAll();
    ok(slotRow() && !/Has no effect yet/.test(textOf(slotRow())), 'VEIP slot: with bit 256 set there is no warning');
    S.VALUES.OMCI_CUSTOM_ME = '1';
    renderAll();
  }

  /* An identity key the switch keeps from the OLT changes nothing on the
     line: no cost in the save bar, and no Apply now after the save. */
  EDITS.set('OMCI_SW_VER1', 'V9');
  refreshSaveBar();
  ok(textOf(doc.querySelector('#saveclasses')) === '',
     'save bar: an unreported identity key carries no cost');
  EDITS.clear();
  refreshSaveBar();
  const out1 = new El('div');
  await followUp({ needs: ['omci'], interrupts: true }, ['OMCI_SW_VER1'], out1);
  ok(/Not reported to the OLT/.test(textOf(out1)) && !/Apply now/.test(textOf(out1)),
     'followUp: an unreported identity key is not offered Apply now');
  const out2 = new El('div');
  await followUp({ needs: ['omci'], interrupts: true }, ['GPON_SN'], out2);
  ok(/Apply now/.test(textOf(out2)), 'followUp: the serial number is offered Apply now');
  const out3 = new El('div');
  await followUp({ needs: ['omci'], interrupts: true }, ['OMCI_SW_VER1', 'GPON_SN'], out3);
  ok(/Apply now/.test(textOf(out3)), 'followUp: and so is a batch with one reported key in it');
}

/* Without the table, the page is what it was: every key offered. */
for (const k of Object.keys(S.SETTINGS)) delete S.SETTINGS[k];
renderAll();
ok(inputsOf('#sections') > 100,
   'with no settings table every key is editable, as before');

/* The theme toggle: default follows the browser, a click sets data-theme on
   <html>, persists it, and flips the label; storage that throws is survived. */
{
  const dom = await import(join(root, 'web', 'dom.js'));
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {} });
  const btn = doc.querySelector('#themetoggle');
  let click;
  btn.addEventListener = (ev, fn) => { if (ev === 'click') click = fn; };
  ok(!doc.documentElement.dataset.theme && dom.currentTheme() === 'dark',
     'theme: no choice made follows the browser (dark here)');
  dom.wireTheme();
  ok(btn.getAttribute('aria-label') === 'Switch to light mode', 'theme: label names the mode it switches to');
  ok(doc.querySelector('#ico-sun').getAttribute('hidden') === null && doc.querySelector('#ico-moon').getAttribute('hidden') !== null,
     'theme: in dark mode the sun is shown');
  click();
  ok(doc.documentElement.dataset.theme === 'light' && store.get(dom.THEME_KEY) === 'light',
     'theme: a click sets data-theme and persists it');
  ok(btn.getAttribute('aria-label') === 'Switch to dark mode' && doc.querySelector('#ico-moon').getAttribute('hidden') === null && doc.querySelector('#ico-sun').getAttribute('hidden') !== null,
     'theme: the label and icon follow the choice');
  click();
  ok(doc.documentElement.dataset.theme === 'dark' && store.get(dom.THEME_KEY) === 'dark',
     'theme: a second click goes back');
  globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  let threw = false;
  try { click(); } catch (e) { threw = true; }
  ok(!threw && doc.documentElement.dataset.theme === 'light', 'theme: works with storage blocked');
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  ok(/<script>[^<]*localStorage\.getItem\("odi-theme"\)[^<]*<\/script>/.test(head) &&
     head.indexOf('localStorage') < head.indexOf('style.css'),
     'theme: an inline script in the head sets the attribute before the stylesheet');
  ok(dom.THEME_KEY === 'odi-theme', 'theme: the head script and dom.js use one storage key');
  const css = readFileSync(join(root, 'web', 'style.css'), 'utf8');
  ok(/:root\[data-theme="light"\]\s*\{/.test(css) && /:root:not\(\[data-theme="dark"\]\)/.test(css),
     'theme: style.css lets data-theme override the media query');
  delete doc.documentElement.dataset.theme;
}

/* Receive and transmit are read at the same size, weight and unit styling. */
{
  const css = readFileSync(join(root, 'web', 'style.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]*\.m-read[^{}]*)\{([^}]*)\}/g)].map((m) => [m[1].trim(), m[2].trim()]);
  const forMeter = (sel) => rules.filter(([s]) => s.split(',').some((x) => x.includes(sel)));
  ok(forMeter('#rx').length === 0 && forMeter('#tx').length === 0,
     'readout: no rule sizes receive or transmit differently');
  ok(rules.filter(([s]) => /\.m-read \.num\b/.test(s)).length === 1 &&
     rules.filter(([s]) => /\.m-read \.unit\b/.test(s)).length === 1,
     'readout: one rule for the number and one for the unit, shared by both meters');
}

/* --- the Phone view: the parser of `omcicli voip` ---------------------- */
{
  const { parseVoip } = await import(join(root, 'web', 'phone.js'));
  const masked = [
    'port 0x201 (voice CTP 0x1)',
    '  sip user 0x1: aor MASKED-5678, display name MASKED-mple',
    '  sip user login 0x3: username MASKED-user, password set (8 bytes), realm example.net',
    '  sip agent 0x1',
    '    proxy sip:proxy.example.net',
    '    registrar registrar.example.net',
    '    port 5060/udp',
    '    expiry 3600 s',
    '  media profile 0x1: codecs PCMU/20ms PCMA/20ms, dtmf out of band',
    '    rtp ports 50000-50100 dscp 46',
    '  voice vlan 100 priority 5 (IP host 0x1)',
    '  line status config done (14)',
  ].join('\n');
  const v = parseVoip(masked);
  const rows = Object.fromEntries(v.ports[0].rows);
  ok(v.ports.length === 1 && v.ports[0].status === 'config done (14)', 'phone: one port, its line status');
  ok(rows['SIP user'] === 'MASKED-5678' && rows.Password === 'set (8 bytes)' && rows.Realm === 'example.net',
     'phone: the masked user and password are shown as printed');
  ok(rows.Proxy === 'sip:proxy.example.net' && rows.Registrar === 'registrar.example.net' && rows['SIP port'] === '5060/udp',
     'phone: proxy, registrar and port');
  ok(rows.Codecs === 'PCMU/20ms PCMA/20ms' && rows['Voice VLAN'] === '100 priority 5 (IP host 0x1)',
     'phone: codecs and the voice VLAN');
  ok(!('Other' in rows), 'phone: every line of the output is understood');
  ok(parseVoip('no voice provisioned\n').none === true, 'phone: no voice provisioned');
  const sec = parseVoip('port 0x201 (voice CTP 0x1)\n  sip user login 0x3: username u, ok, password p, w, realm r.net\n');
  ok(Object.fromEntries(sec.ports[0].rows).Password === 'p, w', 'phone: a password with a comma is kept whole');
}


/* --- the setup wizard ---------------------------------------------------- */
{
  const wz = await import(join(root, 'web', 'wizard.js'));
  const { lineFacts } = await import(join(root, 'web', 'status.js'));
  const { W } = wz;
  wz.wireWizard();
  const keepFetch = globalThis.fetch;
  const keepS = { V: S.VALUES, SET: S.SETTINGS, FW: S.FW };
  const diag = (state, rx, los) => 'RTK.0> pon get transceiver rx-power\n  Rx Power          : ' + rx + ' dBm\n'
    + 'RTK.0> gpon get onu-state\n  Operation State(' + state + ')\n'
    + 'RTK.0> gpon get alarm-status\n  LOS Alarm         : ' + (los ? 'asserted' : 'clear') + '\n  LOF Alarm         : clear\n';

  /* What a stick configured by hand holds: every key the wizard reads. */
  const HELD = {
    GPON_SN: 'ODIX00000001', GPON_PLOAM_PASSWD: '31323334353637383930', LOID: 'oldloid', LOID_OLD: 'oldloid',
    LOID_PASSWD: 'oldpw', LOID_PASSWD_OLD: 'oldpw', VLAN_CFG_TYPE: '1', VLAN_MANU_MODE: '1',
    VLAN_MANU_TAG_VID: '110', VLAN_MANU_TAG_PRI: '3',
  };
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxJq2sL3o5p8Qh1u7v9wXyZaBcDeFgHiJkLmNoPqRsT laptop';
  const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkK desk';
  let INSTALLED = [];
  let calls = [];
  let sw = {};
  globalThis.fetch = async (path, init = {}) => {
    const [key] = String(path).split('?');
    const method = init.method || 'GET';
    const body = init.body || '';
    calls.push({ key, method, body, auth: (init.headers || {}).Authorization });
    const ans = (j) => ({ ok: true, status: 200, json: async () => j });
    if (key === '/api/switch' && method === 'POST') {
      const f = new URLSearchParams(body);
      sw[f.get('name')] = f.get('on') === '1';
      S.FW.switches = { ...S.FW.switches, [f.get('name')]: f.get('on') === '1' };
      return ans({ ok: true, on: f.get('on') === '1' });
    }
    if (key === '/api/config') {
      const f = [...new URLSearchParams(body).keys()].filter((k) => k !== '_confirm');
      return ans({ results: f.map((name) => ({ name, ok: true, value: 'x' })), needs: ['omci'],
                   interrupts: f.some((k) => !k.startsWith('VLAN_')) });
    }
    if (key === '/api/values') {
      const last = calls.filter((c) => c.key === '/api/config').pop();
      return ans({ ...HELD, ...(last ? Object.fromEntries(new URLSearchParams(last.body)) : {}) });
    }
    if (key === '/api/apply') return ans({ ok: true, output: 'secret-looking output' });
    if (key === '/api/password') return ans({ ok: true });
    if (key === '/api/sshkeys' && method === 'GET' && INSTALLED === null) return ans({ ok: false, error: 'authorized_keys is larger than confd can hold (4 KB); edit it over ssh' });
    if (key === '/api/sshkeys' && method === 'GET') return ans({ path: 'x', keys: INSTALLED.map((line, i) => ({ i, line })) });
    if (key === '/api/sshkeys') {
      const line = new URLSearchParams(body).get('key');
      if (INSTALLED.includes(line)) return ans({ ok: false, error: 'that key is already in the file' });
      INSTALLED.push(line);
      return ans({ ok: true });
    }
    if (key === '/api/status') return ans({ raw: diag('O5', '-18.42', false) });
    if (key === '/api/omci') return ans({ ok: true, raw: '' });
    return keepFetch(path, init);
  };
  const posts = (k) => calls.filter((c) => c.key === k && c.method === 'POST');
  const reset = (fw = {}) => {
    calls = [];
    sw = {};
    INSTALLED = [];
    S.FW = { switches: { 'omci-identity.on': false, 'confd.setup': false }, defaultauth: false, ...fw };
    S.VALUES = { ...HELD };
    S.SETTINGS = Object.fromEntries(SETT.map((r) => [r.name, r]));
    Object.assign(W, { open: false, autoTried: false, marking: false, pwChanged: false, phase: 'edit' });
  };
  const all = (n, pred, out = []) => {
    if (pred(n)) out.push(n);
    for (const c of n.children || []) all(c, pred, out);
    return out;
  };
  const byId = (id) => all(doc.querySelector('#wizard-body'), (n) => n.id === id)[0];
  const type = (id, v) => { const i = byId(id); i.value = v; i.oninput(); };
  const body = () => textOf(doc.querySelector('#wizard-body'));
  const title = () => doc.querySelector('#wizard-title').textContent;
  const click = (id) => doc.querySelector(id).onclick();
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');

  /* the rule, as a pure decision */
  const st = (marker) => ({ FW: { switches: { 'confd.setup': marker } } });
  const L = (state, rx, los) => lineFacts(diag(state, rx, los));
  ok(wz.decide(L('O1', '-18.4', false), st(false)) === 'open', 'wizard rule: no marker, light, not O5 opens');
  ok(wz.decide(L('O3', '-18.4', false), st(false)) === 'open', 'wizard rule: any state short of O5 opens');
  ok(wz.decide(L('O1', '-18.4', true), st(false)) === 'none', 'wizard rule: LOS does not open it');
  ok(wz.decide(L('O1', '-45.00', false), st(false)) === 'none', 'wizard rule: no light (below the receive scale) does not open it');
  ok(wz.decide(lineFacts('RTK.0> gpon get onu-state\n  Operation State(O1)\n'), st(false)) === 'none',
     'wizard rule: no receive reading is not light');
  ok(wz.decide(L('O5', '-18.4', false), st(false)) === 'mark', 'wizard rule: O5 writes the marker and does not open');
  ok(wz.decide(L('O5', '-18.4', false), st(true)) === 'none', 'wizard rule: a marker already there, O5, does nothing');
  ok(wz.decide(L('O1', '-18.4', false), st(true)) === 'none', 'wizard rule: a marker present does not open it');
  ok(wz.decide(null, st(false)) === 'none', 'wizard rule: a failed status read does nothing');
  ok(wz.decide(L('O1', '-18.4', false), { FW: {} }) === 'none', 'wizard rule: no firmware read, no marker support: nothing');

  /* the page level: what wizardSeen does with each */
  reset();
  await wz.wizardSeen(L('O1', '-18.4', true));
  ok(!wz.isOpen() && !posts('/api/switch').length, 'fibre down: the wizard stays shut and nothing is written');
  await wz.wizardSeen(L('O5', '-18.4', false));
  ok(!wz.isOpen() && posts('/api/switch').length === 1 && sw['confd.setup'] === true,
     'O5: the marker is written silently and the wizard stays shut');
  await wz.wizardSeen(L('O1', '-18.4', false));
  ok(!wz.isOpen(), 'a marker present: the wizard does not open');
  reset();
  await wz.wizardSeen(L('O1', '-18.4', false));
  ok(wz.isOpen() && W.auto && !posts('/api/switch').length, 'no marker, light, not O5: the wizard opens and writes nothing yet');
  ok(title() === 'Admin access' && !byId('wiz-pw-pass'), 'the wizard starts at the access step, with no password field when the password is not the default');
  await wz.exitWizard();
  reset({ defaultauth: true });
  await wz.wizardSeen(L('O1', '-18.4', false));
  ok(title() === 'Admin access' && byId('wiz-pw-pass'), 'with the default password the access step asks for one');
  await wz.exitWizard();
  reset();
  S.SETTINGS = {};
  await wz.wizardSeen(L('O1', '-18.4', false));
  ok(!wz.isOpen(), 'an image that does not say what its keys cost never gets the wizard');

  /* every way out writes the marker, from every step */
  let esc = false;
  for (const [name, exit] of [
    ['Skip', () => click('#wizard-skip')],
    ['the close button', () => click('#wizard-x')],
    ['Escape', () => wz.onCancel({ preventDefault() { esc = true; } })],
  ]) {
    for (const step of ['isp', 'vlan', 'review']) {
      reset();
      esc = false;
      await wz.wizardSeen(L('O1', '-18.4', false));
      while (title() !== { isp: 'Your ISP login', vlan: 'VLAN', review: 'Review and apply' }[step]) await wz.next();
      await exit();
      await tick();
      ok(!wz.isOpen() && sw['confd.setup'] === true && posts('/api/switch').length === 1 && (name !== 'Escape' || esc),
         `${name} on the ${step} step writes the marker and closes`);
    }
  }
  /* the Skip button exists on every step and has the documented label */
  reset({ defaultauth: true });
  wz.openWizard(true);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    seen.push(String(doc.querySelector('#wizard-skip').hidden));
    if (i < 3) await wz.next();
  }
  ok(seen.length === 4 && seen.every((x) => x === 'false')
     && /<button id="wizard-skip"(?![^>]*hidden)[^>]*>Skip, I'll use Config<\/button>/.test(html),
     "Skip, I'll use Config is there, and visible, on every step");
  await wz.exitWizard();
  /* a page unload mid-wizard is the one exit that leaves the marker unset: nothing is written on open or on a step */
  reset();
  wz.openWizard(true);
  ok(posts('/api/switch').length === 0 && !wz.markerOn(), 'opening and walking the wizard writes no marker by itself');
  await wz.exitWizard();

  /* validation, as docs/SETTINGS.md and the daemon have it */
  const pl = wz.ploamParse;
  ok(pl('').empty === true, 'PLOAM: empty means unchanged');
  ok(pl('abc').hex === '61626300000000000000', 'PLOAM: 1 to 10 characters are the text, zero-padded');
  ok(pl('1234567890').hex === '31323334353637383930', 'PLOAM: ten characters are text');
  ok(pl('deadbeef').hex === '64656164626565660000', 'PLOAM: text that is all hex digits is still text');
  ok(pl('31323334353637383930').hex === '31323334353637383930', 'PLOAM: exactly 20 hex digits are the ten bytes');
  ok(pl('ABCDEF0123456789ABCD').hex === 'abcdef0123456789abcd', 'PLOAM: 20 hex digits in capitals');
  ok(pl('0x1234').hex === '12340000000000000000', 'PLOAM: 0x and hex digits are bytes, zero-padded');
  ok(pl('0x' + '12'.repeat(10)).hex === '12'.repeat(10), 'PLOAM: 0x and 20 digits');
  ok(pl('0x123').hex === '3078313233' + '0'.repeat(10), 'PLOAM: 0x with an odd count is five characters of text');
  ok(pl('0x12345678').hex === '12345678' + '0'.repeat(12), 'PLOAM: 0x and 8 digits is hex even though it is 10 characters');
  ok(pl('12345678901').error && pl('1'.repeat(19) + 'x').error, 'PLOAM: 11 to 19 characters are refused');
  ok(pl('z'.repeat(20)).error, 'PLOAM: 20 characters that are not hex are refused');
  ok(pl('0x' + '1'.repeat(22)).error, 'PLOAM: more than 20 hex digits are refused');
  ok(pl('café').error, 'PLOAM: not printable ASCII is refused');
  ok(!/secretsecretsecret/.test(pl('secretsecretsecret').error), 'PLOAM: the message never repeats the input');
  const bad = (f) => wz.problems({ sn: 'ODI012345678', ploam: '', loid: '', loidpw: '', vlan: 'olt', vid: '', pri: '0', ...f });
  ok(!bad({}).sn, 'serial: four characters and eight hex digits pass');
  ok(bad({ sn: 'ODI01234567' }).sn && bad({ sn: 'ODI0123456789' }).sn && bad({ sn: 'ODI0123456zz' }).sn,
     'serial: eleven, thirteen characters and non-hex digits are refused');
  ok(bad({ sn: '' }).sn, 'serial: empty is refused');
  ok(!('vid' in bad({ vlan: 'router' })) && !('vid' in bad({ vlan: 'olt' })), 'VLAN ID is only judged when the stick tags');
  ok(!bad({ vlan: 'stick', vid: '1' }).vid && !bad({ vlan: 'stick', vid: '4094' }).vid, 'VID: 1 and 4094 pass');
  ok(bad({ vlan: 'stick', vid: '0' }).vid && bad({ vlan: 'stick', vid: '4095' }).vid && bad({ vlan: 'stick', vid: '' }).vid
     && bad({ vlan: 'stick', vid: '01' }).vid && bad({ vlan: 'stick', vid: '1x' }).vid,
     'VID: 0, 4095, empty, a leading zero and letters are refused');
  ok(!bad({ vlan: 'stick', vid: '5', pri: '0' }).pri && !bad({ vlan: 'stick', vid: '5', pri: '7' }).pri, 'PRI: 0 and 7 pass');
  ok(bad({ vlan: 'stick', vid: '5', pri: '8' }).pri && bad({ vlan: 'stick', vid: '5', pri: '' }).pri
     && bad({ vlan: 'stick', vid: '5', pri: '-1' }).pri, 'PRI: 8, empty and negative are refused');
  ok(bad({ loid: 'x'.repeat(25) }).loid && bad({ loidpw: 'x'.repeat(13) }).loidpw && bad({ loid: 'a"b' }).loid,
     'LOID: longer than the field, or a quote, is refused');

  /* the choice -> key mapping, only the keys that differ */
  const keys = (f, V) => JSON.stringify(Object.fromEntries(wz.vlanKeys({ vid: '110', pri: '3', ...f }, V)));
  ok(keys({ vlan: 'router' }, { VLAN_CFG_TYPE: '0' }) === '{"VLAN_CFG_TYPE":"1","VLAN_MANU_MODE":"0"}',
     'VLAN: "my router tags" is VLAN_CFG_TYPE 1 with VLAN_MANU_MODE 0 (transparent)');
  ok(keys({ vlan: 'stick', vid: '35', pri: '5' }, { VLAN_CFG_TYPE: '0' })
     === '{"VLAN_CFG_TYPE":"1","VLAN_MANU_MODE":"1","VLAN_MANU_TAG_VID":"35","VLAN_MANU_TAG_PRI":"5"}',
     'VLAN: "the stick tags" is type 1, mode 1, the VID and the priority');
  ok(keys({ vlan: 'olt' }, { VLAN_CFG_TYPE: '1', VLAN_MANU_MODE: '1' }) === '{"VLAN_CFG_TYPE":"0"}',
     'VLAN: "let the OLT decide" is VLAN_CFG_TYPE 0 and touches nothing else');
  ok(keys({ vlan: 'olt' }, { VLAN_CFG_TYPE: '2' }) === '{}' && keys({ vlan: 'olt' }, {}) === '{}',
     'VLAN: the OLT rule already in force (any type but 1) writes nothing');
  ok(keys({ vlan: 'stick', vid: '110', pri: '3' }, HELD) === '{}', 'VLAN: the same tag as stored writes nothing');
  ok(keys({ vlan: 'stick', vid: '110', pri: '0' }, { ...HELD, VLAN_MANU_TAG_PRI: '255' }) === '{}',
     'VLAN: the factory priority 255 is read as 0, as the image does');
  ok(keys({ vlan: 'router' }, { ...HELD, VLAN_MANU_MODE: '0' }) === '{}', 'VLAN: already transparent writes nothing');
  ok(wz.choiceOf({ VLAN_CFG_TYPE: '1', VLAN_MANU_MODE: '0' }) === 'router' && wz.choiceOf({ VLAN_CFG_TYPE: '1', VLAN_MANU_MODE: '1' }) === 'stick'
     && wz.choiceOf({ VLAN_CFG_TYPE: '0' }) === 'olt' && wz.choiceOf({}) === 'olt' && wz.choiceOf({ VLAN_CFG_TYPE: '7', VLAN_MANU_MODE: '1' }) === 'olt',
     'VLAN: the stored keys read back as the question the wizard asks');

  /* pre-filled from the stick, untouched secrets are not rewritten */
  reset();
  const f0 = wz.initForm();
  ok(f0.sn === 'ODIX00000001' && f0.loid === 'oldloid' && f0.vlan === 'stick' && f0.vid === '110' && f0.pri === '3',
     'the form is pre-filled with the stick values');
  ok(f0.ploam === '' && f0.loidpw === '', 'secrets are never pre-filled');
  ok(wz.planChanges(f0).pairs.length === 0, 'an untouched form writes nothing, secrets included');
  const one = wz.planChanges({ ...f0, sn: 'ODIX00000002' }).pairs;
  ok(one.length === 1 && one[0][0] === 'GPON_SN', 'only the changed key is written');
  const pw = wz.planChanges({ ...f0, ploam: 'abc', loidpw: 'newpw' });
  ok(pw.pairs.map(([k]) => k).join() === 'GPON_PLOAM_PASSWD,LOID_PASSWD,LOID_PASSWD_OLD',
     'a changed PLOAM and LOID password write theirs, with the OLD pair');
  ok(wz.planChanges({ ...f0, ploam: '1234567890' }).pairs.length === 0, 'the PLOAM password already stored, typed again, is no change');
  ok(wz.writeBody(pw.pairs).includes('_confirm=identity'), 'an identity key carries the confirmation');
  ok(!wz.writeBody([['VLAN_MANU_TAG_VID', '5']]).includes('_confirm'), 'a VLAN-only write does not');

  /* review masking: typed secrets never reach the page text */
  reset();
  wz.openWizard(true);
  await wz.next();
  type('wiz-sn', '4F44 4958 0000 0009');
  ok(wz.W.f.sn === 'ODIX00000009' && byId('wiz-sn').value === 'ODIX00000009' && !wz.problems(wz.W.f).sn,
     'wizard: a serial typed as 16 hex digits is converted in the field');
  type('wiz-sn', 'ODIX00000009');
  type('wiz-ploam', 'hunter2pw');
  type('wiz-loid', 'newloid');
  type('wiz-loidpw', 'loidsecret');
  await wz.next(); await wz.next();
  ok(title() === 'Review and apply', 'the wizard reaches the review');
  const rv = body();
  ok(rv.includes('ODIX00000001') && rv.includes('ODIX00000009') && rv.includes('newloid'), 'review: old and new serial and LOID in the clear');
  ok(!/hunter2pw|loidsecret|oldpw|31323334/.test(rv) && rv.includes('•••'), 'review: secrets are dots, old and new, and not in the text');
  ok(/internet drops/.test(rv), 'review: the internet-drop warning is there for identity keys');
  ok(rv.includes('LOID_OLD') && rv.includes('LOID_PASSWD_OLD'), 'review: the paired OLD keys are listed');
  await wz.exitWizard();

  /* apply from the wizard writes exactly the expected keys */
  reset();
  wz.openWizard(true);
  await wz.next();
  type('wiz-sn', 'ODIX00000009');
  type('wiz-ploam', 'abc');
  await wz.next(); await wz.next();
  ok(title() === 'Review and apply', 'apply: at the review');
  await click('#wizard-next');
  const cfg = posts('/api/config');
  ok(cfg.length === 1 && cfg[0].body === 'GPON_SN=ODIX00000009&GPON_PLOAM_PASSWD=61626300000000000000&_confirm=identity',
     'apply: exactly the changed keys, the PLOAM password as the converted hex, and the identity confirmation: ' + (cfg[0] || {}).body);
  ok(posts('/api/apply').length === 1 && /what=omci/.test(posts('/api/apply')[0].body), 'apply: omci is applied after the write');
  ok(sw['confd.setup'] === true, 'apply: completing writes the marker');
  ok(W.phase === 'live' && title() === 'Registering with the OLT', 'apply: the live view follows');
  ok(!/secret-looking/.test(body()), 'apply: the script output is not shown');
  await tick();
  ok(/Operational/.test(body()), 'live: O5 is reported');
  await click('#wizard-next');
  ok(!wz.isOpen(), 'live: Finish closes the wizard');

  /* a VLAN-only change is applied without the internet-drop warning */
  reset();
  wz.openWizard(true);
  await wz.next(); await wz.next();
  type('wiz-vid', '120');
  await wz.next();
  ok(!/internet drops/.test(body()) && /VLAN 120 instead of 110/.test(body()), 'review: a VLAN change warns about the VLAN, not the internet');
  await click('#wizard-next');
  ok(posts('/api/config')[0].body === 'VLAN_MANU_TAG_VID=120', 'apply: a VLAN-only change writes only the VID');
  await wz.exitWizard();

  /* nothing to write: Finish just writes the marker */
  reset();
  wz.openWizard(false);
  await wz.next(); await wz.next(); await wz.next();
  ok(/nothing to write/.test(body()) && doc.querySelector('#wizard-next').textContent === 'Finish', 'review: nothing changed says so');
  await click('#wizard-next');
  ok(!posts('/api/config').length && sw['confd.setup'] === true && !wz.isOpen(),
     'a legacy stick can review and leave: nothing written but the marker');

  /* the admin password: saved last, with the new credential, then a sign-out */
  reset({ defaultauth: true });
  wz.openWizard(true);
  type('wiz-pw-pass', 'pa55word');
  type('wiz-pw-again', 'pa55wor');
  ok(doc.querySelector('#wizard-next').disabled === true && /not the same/.test(byId('wiz-pw-again-msg').textContent),
     'password: a mismatch blocks Next');
  type('wiz-pw-again', 'pa55word');
  ok(doc.querySelector('#wizard-next').disabled === false, 'password: matching passwords allow Next');
  await wz.next(); await wz.next(); await wz.next();
  ok(!/pa55word/.test(body()) && /Admin password/.test(body()), 'password: the review shows it as dots');
  await click('#wizard-next');
  const pc = posts('/api/password');
  ok(pc.length === 1 && posts('/api/config').length === 0, 'password: with nothing else to write, only the password is saved');
  ok(W.pwChanged && calls.filter((c) => c.key === '/api/status').length > 0
     && calls.every((c) => c.auth === undefined),
     'password: the live view goes on with the session, no credential of its own');
  const keepLoc = globalThis.location.href;
  await wz.exitWizard();
  ok(globalThis.location.href === keepLoc, 'password: closing does not sign out (the session survives the change)');
  reset({ defaultauth: true });
  wz.openWizard(true);
  const skipPw = all(doc.querySelector('#wizard-body'), (n) => n.tagName === 'button' && n.textContent === 'Skip the password')[0];
  ok(skipPw && /built-in admin/.test(body()), 'password: skipping the step is offered, with a warning');
  skipPw.onclick();
  ok(title() === 'Your ISP login' && W.pw === null, 'password: skipping goes on to the ISP step and keeps nothing');
  await wz.exitWizard();

  /* the SSH key: shown against what is installed, checked like System, Access, added through /api/sshkeys */
  reset();
  INSTALLED = [KEY];
  wz.openWizard(true);
  await tick();
  ok(/1 key installed: ssh-ed25519 laptop/.test(textOf(doc.querySelector('#wizard-body'))) && !body().includes('AAAAC3'),
     'ssh key: the installed keys are shown as a count and comments, never the key');
  ok(/no ssh password/.test(body()), 'ssh key: the step says ssh uses keys only');
  type('wiz-sshkey', 'hello world');
  ok(doc.querySelector('#wizard-next').disabled === true && byId('wiz-sshkey-msg').textContent !== '', 'ssh key: a line that is not a key blocks Next');
  type('wiz-sshkey', KEY);
  ok(doc.querySelector('#wizard-next').disabled === true && /already in the list/.test(byId('wiz-sshkey-msg').textContent),
     'ssh key: a key already installed is refused before it is sent');
  type('wiz-sshkey', KEY2);
  ok(doc.querySelector('#wizard-next').disabled === false && byId('wiz-sshkey-msg').textContent === '', 'ssh key: a good new key passes');
  await wz.next(); await wz.next(); await wz.next();
  ok(/SSH key/.test(body()) && /add ssh-ed25519 desk/.test(body()) && !body().includes('AAAAC3') && !/AAAAIKkK/.test(body()),
     'ssh key: the review says "add <type> <comment>" and never shows the key');
  await click('#wizard-next');
  const sk = posts('/api/sshkeys');
  ok(sk.length === 1 && new URLSearchParams(sk[0].body).get('key') === KEY2 && !posts('/api/config').length,
     'ssh key: apply appends exactly that key through /api/sshkeys and writes no config key');
  ok(INSTALLED.length === 2 && /SSH key: added/.test(body()), 'ssh key: and says so');
  await wz.exitWizard();
  /* a key with no password step on a default-password stick, and the daemon refusing a duplicate that raced in */
  reset();
  wz.openWizard(true);
  await tick();
  type('wiz-sshkey', KEY);
  INSTALLED = [KEY];
  await wz.next(); await wz.next(); await wz.next();
  await click('#wizard-next');
  ok(/SSH key: that key is already in the file/.test(body()), 'ssh key: a duplicate the daemon refuses is reported, not hidden');
  await wz.exitWizard();
  reset();
  wz.openWizard(true);
  await tick();
  await wz.next(); await wz.next(); await wz.next();
  await click('#wizard-next');
  ok(!posts('/api/sshkeys').length, 'ssh key: skipping it sends nothing');
  /* a key file the daemon refuses to list is not "no keys" */
  await wz.exitWizard();
  reset();
  INSTALLED = null;
  wz.openWizard(true);
  await tick();
  ok(/could not be listed: authorized_keys is larger/.test(body()) && !/No keys installed yet/.test(body()),
     'ssh key: a key file the daemon will not list is reported, not shown as no keys');
  INSTALLED = [];

  /* the hints under the ladder */
  ok(wz.liveHint(L('O5', '-18', false), 0).cls === 'good', 'live hint: O5 is good news');
  ok(/loss of signal/.test(wz.liveHint(L('O1', '-18', true), 0).text), 'live hint: LOS says there is no light on the fibre');
  ok(/wrong serial number or PLOAM/.test(wz.liveHint(L('O3', '-18', false), 20).text),
     'live hint: stuck before O5 with light points at the serial and the PLOAM password');
  ok(!/wrong serial/.test(wz.liveHint(L('O3', '-18', false), 2).text), 'live hint: not yet, early in the registration');
  ok(wz.liveHint(L('O5', '-18', false), 40, { gem: 0, o5Polls: 1 }).cls !== 'bad',
     'live hint: reaching O5 late is not a missing service at once');
  ok(wz.liveHint(L('O5', '-18', false), 40, { gem: 0, o5Polls: 12 }).cls === 'bad',
     'live hint: but no service after the stall in O5 is');

  globalThis.fetch = keepFetch;
  S.VALUES = keepS.V; S.SETTINGS = keepS.SET; S.FW = keepS.FW;
}

/*
 * The update notice. The release list comes from the internet, so what is
 * tested is mostly what it may NOT do: the version rules, the daily limit, the
 * notes rendering inert, and storage failing.
 */
{
  const U = await import(join(root, 'web', 'updates.js'));
  const v = U.parseVersion;
  const lt = (a, b) => U.compareVersions(v(a), v(b)) < 0;
  ok(v('v1.12.0') && v('v1.12.0').minor === 12 && v('v1.13.0-beta.1').pre.join('.') === 'beta.1',
     'updates: release tags parse, with and without a prerelease');
  ok(['hostserdes4', '1.12.0', 'v1.12', 'v1.12.0+x', 'v1.2.3-', 'ODI-260910-6861b53', '', undefined, 'v1.12.0 '].every((t) => v(t) === null),
     'updates: anything else is not a release tag');
  ok(lt('v1.13.0-beta.1', 'v1.13.0') && !lt('v1.13.0', 'v1.13.0-beta.1'),
     'updates: 1.13.0-beta.1 is older than 1.13.0');
  ok(lt('v1.12.9', 'v1.13.0-beta.1') && lt('v1.9.0', 'v1.10.0'), 'updates: numbers compare as numbers');
  ok(lt('v1.13.0-alpha', 'v1.13.0-beta') && lt('v1.13.0-beta.2', 'v1.13.0-beta.11') && lt('v1.13.0-beta', 'v1.13.0-beta.1')
     && lt('v1.13.0-1', 'v1.13.0-a') && lt('v1.13.0-rc.1', 'v1.13.0'), 'updates: prerelease identifiers follow semver precedence');
  ok(U.compareVersions(v('v1.2.3'), v('v1.2.3')) === 0, 'updates: equal versions compare equal');

  const rel = (tag, extra) => ({ tag_name: tag, published_at: '2026-10-20T10:00:00Z',
    html_url: 'https://github.com/AndreZiviani/odi-oss/releases/tag/' + tag, body: 'notes ' + tag, ...extra });
  const LIST = [rel('v1.13.0-beta.1', { prerelease: true }), rel('v1.12.1'), rel('v1.12.0'), rel('v1.11.0'),
    rel('v1.14.0', { draft: true }), rel('not-a-version'), rel('v1.13.0-beta.2', { prerelease: true })];
  const tags = (run) => U.newerReleases(LIST, run).map((r) => r.tag);
  ok(tags('v1.12.0').join() === 'v1.12.1', 'updates: a stable stick is offered stable releases only, drafts and odd tags skipped');
  ok(tags('v1.13.0-beta.1').join() === 'v1.13.0-beta.2', 'updates: a pre-release stick is not offered an older stable one');
  ok(tags('v1.12.1-rc.1').join() === 'v1.13.0-beta.2,v1.13.0-beta.1,v1.12.1',
     'updates: a pre-release stick is offered pre-releases too, newest first');
  ok(tags('v1.12.1').join() === '', 'updates: nothing newer, nothing offered');
  ok(tags('hostserdes4').length === 0 && tags(undefined).length === 0, 'updates: a non-release running version offers nothing');
  ok(U.newerReleases(LIST, 'v1.12.0')[0].url === 'https://github.com/AndreZiviani/odi-oss/releases/tag/v1.12.1',
     'updates: each release carries its tag, date and page link');
  const odd = U.cleanRelease(rel('v1.12.5', { html_url: 'javascript:alert(1)' }));
  ok(odd.url === 'https://github.com/AndreZiviani/odi-oss/releases/tag/v1.12.5', 'updates: a page link that is not on github.com is replaced');
  ok(U.cleanRelease(rel('v1.12.5', { html_url: 'https://evil.example/x' })).url.startsWith('https://github.com/'),
     'updates: a page link on another host is replaced');

  /* The daily check, with storage. */
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, x) => { mem.set(k, String(x)); } };
  let calls = 0, mode = 'ok';
  const fake = async (url, opt) => {
    calls++;
    if (url !== U.API_URL || opt.credentials !== 'omit' || opt.referrerPolicy !== 'no-referrer') throw new Error('bad request');
    if (mode === 'throw') throw new Error('offline');
    if (mode === '403') return { ok: false, status: 403, json: async () => ({}) };
    if (mode === 'junk') return { ok: true, status: 200, json: async () => ({ message: 'x' }) };
    return { ok: true, status: 200, json: async () => LIST };
  };
  const fw = (running, off) => ({ running, switches: { 'update-check.off': !!off } });
  const T0 = 1760000000000;
  let got = await U.offered(fw('v1.12.0'), T0, fake);
  ok(calls === 1 && got.length === 1 && got[0].tag === 'v1.12.1', 'updates: the first look fetches once and offers the newer release');
  got = await U.offered(fw('v1.12.0'), T0 + 3600 * 1000, fake);
  ok(calls === 1 && got.length === 1, 'updates: within a day the cache answers, no second fetch');
  got = await U.offered(fw('v1.12.1'), T0 + 7200 * 1000, fake);
  ok(calls === 1 && got.length === 0, 'updates: a new running version is judged from the cache, not refetched');
  mode = '403';
  got = await U.offered(fw('v1.12.0'), T0 + U.DAY_MS + 1000, fake);
  ok(calls === 2 && got.length === 1, 'updates: after a day it asks again; a refusal keeps the old list');
  await U.offered(fw('v1.12.0'), T0 + U.DAY_MS + 2000, fake);
  ok(calls === 2, 'updates: a failed attempt is not retried before the next day');
  mem.clear(); mode = 'throw';
  got = await U.offered(fw('v1.12.0'), T0, fake);
  ok(got.length === 0, 'updates: offline is silent and offers nothing');
  mem.clear(); mode = 'junk';
  got = await U.offered(fw('v1.12.0'), T0, fake);
  ok(got.length === 0, 'updates: an answer that is not a list is silent');
  mem.set(U.CACHE_KEY, '{not json');
  mode = 'ok';
  got = await U.offered(fw('v1.12.0'), T0, fake);
  ok(got.length === 1, 'updates: a damaged cache is ignored');
  const before = calls;
  ok((await U.offered(fw('v1.12.0', true), T0 + 9 * U.DAY_MS, fake)).length === 0 && calls === before,
     'updates: switched off on the stick, nothing is fetched or offered');
  ok((await U.offered(fw('hostserdes4'), T0 + 9 * U.DAY_MS, fake)).length === 0 && calls === before,
     'updates: a local build name is skipped without a fetch');

  /* Storage that throws: no crash, and the answer still comes. */
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  calls = 0;
  got = await U.offered(fw('v1.12.0'), T0, fake);
  ok(got.length === 1 && calls === 1, 'updates: storage that throws still gives the notice');
  delete globalThis.localStorage;
  got = await U.offered(fw('v1.12.0'), T0, fake);
  ok(got.length === 1, 'updates: no storage at all still gives the notice');

  /* What the dialog leaves out. */
  const page = Array.from({ length: 30 }, (_, i) => rel('v1.' + (30 - i) + '.0'));
  mem.clear(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, x) => { mem.set(k, String(x)); } };
  const fakePage = async () => ({ ok: true, status: 200, json: async () => page });
  let lk = await U.lookup(fw('v1.5.0'), T0, fakePage);
  ok(lk.offer.length === 25 && !lk.cut && U.olderLine(lk.offer.length, lk.cut) === '15 older releases not shown',
     'updates: more newer releases than the dialog lists says how many are left out');
  lk = await U.lookup(fw('v1.5.0'), T0 + 1000, fakePage);
  ok(lk.offer.length === 25, 'updates: the cached list gives the same count');
  mem.clear();
  lk = await U.lookup(fw('v1.0.0'), T0, fakePage);
  ok(lk.cut && U.olderLine(lk.offer.length, lk.cut) === 'Older releases not shown',
     'updates: a full page whose oldest is newer than the running version may have cut older ones off');
  mem.clear();
  lk = await U.lookup(fw('v1.12.0'), T0, async () => ({ ok: true, json: async () => page.slice(0, 10) }));
  ok(!lk.cut && U.olderLine(5, false) === '' && U.olderLine(11, false) === '1 older release not shown',
     'updates: a short page, or a running version inside it, leaves nothing out');
  lk = await U.lookup(fw('v1.12.0'), T0 + 1000, fakePage);
  ok(!lk.cut, 'updates: a running version inside a full page leaves nothing out');
  {
    const n = U.olderNode(25, false), a = n.children[0];
    ok(U.olderNode(10, false) === null && a.textContent === '15 older releases not shown' && a.attrs.href === 'https://github.com/AndreZiviani/odi-oss/releases'
       && a.attrs.rel === 'noopener noreferrer' && a.attrs.target === '_blank' && U.olderNode(3, true).children[0].textContent === 'Older releases not shown',
       'updates: the last line is a noopener link to the releases list, and absent when nothing is left out');
  }

  /* Dismissal is per version. */
  const offer = U.newerReleases(LIST, 'v1.12.0');
  ok(U.barShown(offer, null) && !U.barShown(offer, 'v1.12.1') && U.barShown(offer, 'v1.11.0') && !U.barShown([], null),
     'updates: the bar hides for the dismissed version and returns for a newer one');

  /* The notes: markdown from the internet, shown as text. */
  const walk = (n, f) => { f(n); for (const c of n.children || []) walk(c, f); };
  const nodesOf = (body) => { const all = []; walk(U.notesNode(body), (n) => all.push(n)); return all; };
  const hostile = [
    '## Changes', '- fixed **bold** and `code`', '- <script>alert(1)</script>', '',
    '<img src=x onerror="alert(2)">', '[click](javascript:alert(3)) [ok](https://example.com/a?b=1) [d](data:text/html,x)',
    '[cred](https://user:pw@example.com/) [h](http://example.com) <a href=//x.example>y</a>', 'see https://github.com/AndreZiviani/odi-oss/pull/12.',
  ].join('\n');
  const all = nodesOf(hostile);
  const tagsUsed = new Set(all.filter((n) => n.tagName).map((n) => n.tagName));
  ok([...tagsUsed].every((t) => ['div', 'p', 'ul', 'li', 'strong', 'code', 'a'].includes(t)),
     'updates: notes build only div, p, ul, li, strong, code and a elements: ' + [...tagsUsed].join(' '));
  const links = all.filter((n) => n.tagName === 'a');
  ok(links.length === 2 && links[0].attrs.href === 'https://example.com/a?b=1' && links.every((a) => /^https:\/\//.test(a.attrs.href) && a.attrs.rel === 'noopener noreferrer' && a.attrs.target === '_blank'),
     'updates: only https links are made, opened with noopener noreferrer in a new tab');
  ok(links[1].attrs.href === 'https://github.com/AndreZiviani/odi-oss/pull/12' && links[1].textContent === 'https://github.com/AndreZiviani/odi-oss/pull/12',
     'updates: a bare URL becomes a link without its closing full stop');
  const shown = textOf(U.notesNode(hostile));
  ok(shown.includes('<script>alert(1)</script>') && shown.includes('<img src=x onerror="alert(2)">')
     && shown.includes('<a href=//x.example>') && shown.includes('click') && shown.includes('data:') === false,
     'updates: markup in the notes is shown as text, not built');
  ok(all.every((n) => !n.attrs || !Object.keys(n.attrs).some((k) => /^on/i.test(k))), 'updates: no element gets an event handler attribute');
  ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(readFileSync(join(root, 'web', 'updates.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')),
     'updates: updates.js never sets HTML from a string');
  const long = U.parseNotes(Array.from({ length: 500 }, (_, i) => '- item ' + i + '\n\npara ' + i).join('\n'));
  const bullets = U.parseNotes(Array.from({ length: 500 }, (_, i) => '- item ' + i).join('\n'));
  ok(long.blocks.length <= 62 && long.more && bullets.blocks[0].items.length <= 60 && bullets.more,
     'updates: a long body, or a very long list, is cut, and says so');
  ok(U.cleanRelease(rel('v1.12.5', { body: 'x'.repeat(100000) })).body.length === 6000, 'updates: the stored notes are capped');
  const h = U.parseNotes('# T\ntext one\ntext two\n* a\n* b\n1. c\n\nlast');
  ok(h.blocks.map((b) => b.t).join() === 'h,p,ul,p' && h.blocks[2].items.length === 3,
     'updates: headings, paragraphs and bullet lists');
}

const githubCalls = [];
{
  const base = globalThis.fetch;
  globalThis.fetch = async (path, ...rest) => {
    if (String(path).includes('api.github.com')) { githubCalls.push(path); throw new Error('no network'); }
    return base(path, ...rest);
  };
}
await import(join(root, 'web', 'app.js'));
await new Promise((r) => setTimeout(r, 50));
ok(true, 'app.js bootstraps without throwing');
ok(githubCalls.length === 0, 'updates: a stick running a non-release image never contacts GitHub');

{
  /* Removing an SSH key sends the line as it was listed beside its number, so
     the daemon can refuse a list that is out of date; a refusal is shown and
     the list is read again. */
  const { delSshKey } = await import(join(root, 'web', 'app.js'));
  const keep = { fetch: globalThis.fetch, confirm: globalThis.confirm };
  const LINE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5+/AAAAI= me@laptop';
  let sent = null, lists = 0;
  globalThis.confirm = () => true;
  globalThis.fetch = async (path, init) => {
    if (path !== '/api/sshkeys') return keep.fetch(path, init);
    if (!init || init.method !== 'POST') { lists++; return { ok: true, status: 200, json: async () => ({ path: 'x', keys: [] }) }; }
    sent = new URLSearchParams(init.body);
    return { ok: false, status: 409, json: async () => ({ ok: false, error: 'the key list has changed; nothing was removed' }) };
  };
  await delSshKey(1, LINE);
  ok(sent && sent.get('delete') === '1' && sent.get('line') === LINE, 'ssh keys: a removal sends the line as listed with its number');
  ok(/the key list has changed/.test(textOf(doc.querySelector('#sshkey-out'))) && lists === 1,
     'ssh keys: a refused removal says why and reads the list again');
  Object.assign(globalThis, keep);
}

{
  /* The session watcher: a 401 from the stick ends the page, any other answer does not. */
  const { watchSession } = await import(join(root, 'web', 'app.js'));
  const g = {
    location: { origin: 'http://192.168.1.1', hash: '#config/vlan', href: '/' },
    fetch: async (u) => ({ status: u === '/ok' ? 200 : 401,
                           url: u === 'gh' ? 'https://api.github.com/x' : 'http://192.168.1.1' + u }),
  };
  watchSession(g);
  await g.fetch('/ok');
  ok(g.location.href === '/', 'session: a 200 leaves the page where it is');
  await g.fetch('gh');
  ok(g.location.href === '/', 'session: a 401 from another site is not the stick');
  await g.fetch('/api/status');
  ok(g.location.href === '/login#config/vlan', 'session: a 401 from the stick goes to the sign-in page, keeping the view');
  const once = g.fetch;
  watchSession(g);
  ok(g.fetch === once, 'session: wrapping twice wraps once');
}
{
  const { loginOutcome, signIn } = await import(join(root, 'web', 'login.js'));
  ok(loginOutcome(200, { ok: true }).ok, 'sign-in: 200 with ok is a sign-in');
  ok(loginOutcome(401, { ok: false, error: 'wrong username or password' }).text === 'Wrong username or password.',
     'sign-in: a wrong password says so, as a sentence');
  ok(loginOutcome(403, null).text === 'The stick answered 403.', 'sign-in: an answer that is not JSON gives the status');
  let sent = null;
  const out = await signIn('admin', 'p&ss=1', async (path, init) => {
    sent = { path, init };
    return { status: 200, json: async () => ({ ok: true }) };
  });
  ok(out.ok && sent.path === '/api/login' && sent.init.method === 'POST'
     && new URLSearchParams(sent.init.body).get('password') === 'p&ss=1',
     'sign-in: posts the credential to /api/login, form-encoded');
}

/* --- following a reboot ----------------------------------------------------- */
{
  const fw = await import(join(root, 'web', 'firmware.js'));
  const { rebootView: view, rebootLoop: loop, REBOOT_EXPECTED_S: EXP } = fw;
  let v = view('stopping', 0);
  ok(v.pct === 0 && /Shutting down/.test(v.text) && !v.reload, 'reboot: it starts at 0 %, shutting down');
  v = view('starting', Math.round(EXP / 2));
  ok(v.pct === 50 && /Starting up\./.test(v.text), 'reboot: the bar is the time gone against the measured reboot');
  v = view('starting', EXP + 30);
  ok(v.pct === 95 && /longer than usual/.test(v.text) && !v.reload, 'reboot: past the expected time it waits at 95 %');
  v = view('starting', 300);
  ok(v.reload && /reverts to the committed one/.test(v.text) && /keeps trying/.test(v.text),
     'reboot: after 5 minutes it says why, offers Reload and keeps trying');
  v = view('stopping', 60);
  ok(v.reload && /still answers after 60 s/.test(v.text), 'reboot: a stick that never went down is called out');
  v = view('back', 70);
  ok(v.pct === 100 && /sign-in page/.test(v.text), 'reboot: back is 100 % and heads for the sign-in page');
  v = view('stopped', 900);
  ok(v.reload && /stopped following/.test(v.text), 'reboot: giving up says so and offers Reload');

  /* A fake clock: each nap moves it 2 s, each probe answers from a script. */
  const run = async (answers) => {
    let t = 0, gone = 0, i = 0;
    const shown = [];
    const end = await loop({
      probe: async () => (i < answers.length ? answers[i++] : answers[answers.length - 1]),
      sleep: async (ms) => { t += ms; },
      now: () => t,
      go: () => { gone++; },
    }, (x) => shown.push(x));
    return { end, gone, shown, t };
  };
  let r = await run([true, true, false, false, false, true]);
  ok(r.end === 'back' && r.gone === 1, 'reboot: up, down, up again opens the page once');
  ok(/Shutting down/.test(r.shown[1].text) && /Starting up/.test(r.shown[3].text)
     && r.shown[r.shown.length - 1].pct === 100, 'reboot: the words follow the phases, ending at 100 %');
  ok(r.shown.every((x, k) => k === 0 || x.pct >= r.shown[k - 1].pct), 'reboot: the bar never goes backwards');
  r = await run([true, true, true, true]);
  ok(r.end === 'back' || r.end === 'stopped', 'reboot: a stick that keeps answering does not loop forever');
  ok(r.end === 'stopped' && r.gone === 0, 'reboot: and the page is not reopened as if it had rebooted');
  r = await run([false]);
  ok(r.end === 'stopped' && r.gone === 0 && r.t >= 900000, 'reboot: a stick that never comes back stops after 15 minutes');

  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  for (const id of ['reboot-dialog', 'reboot-secs', 'reboot-bar', 'reboot-fill', 'reboot-text', 'reboot-acts', 'reboot-reload']) {
    ok(html.includes(`id="${id}"`), `reboot: index.html has #${id}`);
  }

  /* The dialog itself, driven through the page with the same fakes. */
  let t = 0, gone = 0, i = 0;
  const seq = [true, false, true];
  Object.assign(fw.rebootDeps, {
    probe: async () => seq[Math.min(i++, seq.length - 1)],
    sleep: async (ms) => { t += ms; }, now: () => t, go: () => { gone++; },
  });
  const { S: St } = await import(join(root, 'web', 'state.js'));
  await fw.followReboot();
  ok(St.REBOOTING === true && gone === 1 && doc.querySelector('#reboot-fill').style.width === '100%'
     && /sign-in page/.test(doc.querySelector('#reboot-text').textContent)
     && doc.querySelector('#reboot-acts').hidden === true,
     'reboot: the dialog fills the bar, says where it goes, and the status poll stays off');
  const before = gone;
  await fw.followReboot();
  ok(gone === before, 'reboot: a second request while following starts no second loop');
}

/* --- following a write -------------------------------------------------- */
{
  const fw = await import(join(root, 'web', 'firmware.js'));
  const run = async (answers) => {
    let i = 0, naps = 0;
    const out = doc.querySelector('#fwout');
    out.textContent = '';
    await fw.followLoop('1', {
      get: async () => {
        const a = answers[Math.min(i++, answers.length - 1)];
        if (a === 'fail') throw new Error('HTTP 503');
        return a;
      },
      sleep: async () => { naps++; },
    });
    return { text: textOf(out), polls: i, naps };
  };
  const done = { write: { state: 'ok', slot: '1', rc: '', log: 'fwu: done' } };
  let r = await run(['fail', 'fail', done]);
  ok(/written and read back/.test(r.text) && r.polls === 3 && r.naps === 2,
     'write follow: failed polls are unknown, the loop keeps asking and ends on the real status');
  r = await run(['fail', { write: { state: 'running', slot: '1', rc: '', log: 'erasing' } }, 'fail', done]);
  ok(/written and read back/.test(r.text) && r.polls === 4, 'write follow: running, then a failed poll, then ok');
  r = await run(['fail']);
  ok(r.polls === fw.WRITE_LOST_POLLS && /Lost contact/.test(r.text) && !/written/.test(r.text),
     'write follow: a stick that never answers stops after the bound, and never says written');
  r = await run([{ write: { state: 'failed', slot: '1', rc: '3', log: '' } }]);
  ok(/failed \(exit 3\)/.test(r.text) && !/written/.test(r.text), 'write follow: a failed write is reported as failed');
  r = await run([{ write: { state: 'failed', slot: '1', rc: '', log: '' } }]);
  ok(/failed\./.test(r.text) && !/exit/.test(r.text) && !/written/.test(r.text),
     'write follow: a failed write with no exit code (a vanished writer) ends the loop as failed');
  r = await run([{ write: { state: 'unknown', slot: '1', rc: '', log: '' } }]);
  ok(r.polls === 1 && /ended without recording a result/.test(r.text) && /unknown/.test(r.text) && !/written/.test(r.text),
     'write follow: a writer that is gone with no result ends the loop as unknown, not failed');
  r = await run([{ env: {} }]);
  ok(/written/.test(r.text) && r.polls === 1, 'write follow: an answered poll with no write state is the blocking starter, finished');
}

console.log(failed ? `\n${failed} failed` : '\nweb modules ok');
process.exit(failed ? 1 : 0);
