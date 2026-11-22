/*
 * The stick, drawn: fibre, optics, SoC, host lane, router, each part with
 * its live figure, on top of the Status tab. The idea, a diagram of the
 * stick with a value on every block, came from the modified UI a user
 * shared in odi-oss #300; this is a fresh implementation over the same poll.
 *
 * Everything here is read off the one /api/status answer the page already
 * fetches every 15 s: diag for the optics, the ONU state and the port
 * counters, and plain file reads in confd for CPU, memory, ONU-ID and the
 * host side (src/status.c, emit_overview). A part whose source is missing
 * (a stock slot has no /proc/odi_gpon) shows a dash, never a guess.
 *
 * Clicking a part goes to the section that explains it.
 */

import { $, el, reconcile, bytes } from './dom.js';
import { parsePorts } from './flow.js';
import { serdesShort } from './hostlink.js';

const STATE_NAMES = { O1: 'Initial', O2: 'Standby', O3: 'Serial number', O4: 'Ranging',
  O5: 'In service', O6: 'Intermittent', O7: 'Emergency stop' };

/* A real minus sign, as the meters print it. */
const signed = (v, d) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);

/* The cpu line of /proc/stat: user nice system idle iowait irq softirq steal ...
   Busy is everything but idle and iowait, over the interval between two
   polls, so the first poll has no figure. */
let PREV_CPU = null;
function cpuBusy(line) {
  if (typeof line !== 'string') { PREV_CPU = null; return null; }
  const f = line.trim().split(/\s+/).map(Number);
  if (f.length < 4 || f.some((n) => !Number.isFinite(n))) { PREV_CPU = null; return null; }
  const total = f.reduce((a, b) => a + b, 0);
  const idle = f[3] + (f[4] || 0);
  const prev = PREV_CPU;
  PREV_CPU = { total, idle };
  if (!prev || total <= prev.total) return null;
  return 100 * (1 - (idle - prev.idle) / (total - prev.total));
}

/* "  14792 kB" -> bytes. */
const kb = (s) => {
  const m = /(\d+)\s*kB/.exec(s || '');
  return m ? Number(m[1]) * 1024 : null;
};
const mib = (b) => (b / 1048576).toFixed(1) + ' MiB';

/* The fibre side of the switch is port 2 (flow.js): what it receives came
   down the fibre, what it sends goes up. */
let PREV_PORTS = null;
function fibreRates(counterText) {
  const ports = parsePorts(counterText);
  const now = Date.now();
  const prev = PREV_PORTS;
  PREV_PORTS = ports['2'] ? { at: now, p: ports['2'] } : null;
  if (!prev || !ports['2']) return null;
  const dt = (now - prev.at) / 1000;
  if (dt < 1) return null;
  const rate = (k) => {
    const d = Number(ports['2'][k] || 0) - Number(prev.p[k] || 0);
    return d < 0 ? null : d / dt;
  };
  return { down: rate('ifInOctets'), up: rate('ifOutOctets') };
}

/*
 * The one-second rates. /api/ponload (every second while Status is shown)
 * carries the PON port byte counters as decimal strings; two reads give a
 * rate over a second instead of the 15 s average. Its own state, apart from
 * PREV_PORTS, so the two cadences never read each other. No figure on the
 * first read, when a counter went backwards (a reboot), when the members are
 * absent (a stock slot, an older image) and when the gap since the last read
 * is outside half a second to five seconds (the tab was in the background).
 */
let PREV_LIVE = null;
let LIVE = null;
const LIVE_FRESH_MS = 3000;
function liveRates(p) {
  let a = null, b = null;
  try {
    if (p && typeof p.pon_in_octets === 'string' && typeof p.pon_out_octets === 'string') {
      a = BigInt(p.pon_in_octets.trim());
      b = BigInt(p.pon_out_octets.trim());
    }
  } catch (e) { a = b = null; }
  if (a === null || b === null) { PREV_LIVE = null; LIVE = null; return null; }
  const now = Date.now();
  const prev = PREV_LIVE;
  PREV_LIVE = { at: now, a, b };
  LIVE = null;
  if (!prev) return null;
  const dt = (now - prev.at) / 1000;
  if (dt < 0.5 || dt > 5 || a < prev.a || b < prev.b) return null;
  LIVE = { at: now, r: { down: Number(a - prev.a) / dt, up: Number(b - prev.b) / dt } };
  return LIVE.r;
}

/* Which figure the fibre line shows. A one-second figure younger than three
   seconds wins over the 15 s average of the status poll, so the number does
   not jump back to an average between two ticks; with none (no members, a
   failed read, or the tick stopped) the 15 s figure stands, as it always did. */
const pickRates = (r15) => (LIVE && Date.now() - LIVE.at < LIVE_FRESH_MS ? LIVE.r : r15);

/*
 * How fast the lines move. The light on the fibre and the data on the host
 * pins run at a pace taken from what crosses the fibre port, down and up
 * together, on a log scale: 2.4 s per dash at 1 kB/s or less, 0.4 s at
 * 125 MB/s, a full gigabit. With nothing crossing, both lines stand, so a
 * moving line means traffic, not only light. Before a rate is known (the
 * first poll) the fibre moves at a middle pace while the ONU is in service,
 * as it always did, and the pins wait for a figure. The pace is a custom
 * property on #overview, which reconcile() never replaces.
 */
let PACE = { on: false, los: false, linked: false };
const totalRate = (r) => (r && r.down !== null && r.up !== null ? r.down + r.up : null);
function pace(host, r) {
  if (!host) return;
  const t = totalRate(r);
  if (t === null) host.style.removeProperty('--ov-dur');
  else {
    const x = Math.log10(Math.max(t, 1000));
    host.style.setProperty('--ov-dur', Math.min(2.4, Math.max(0.4, 2.4 - (x - 3) * 2 / 5.1)).toFixed(2) + 's');
  }
  const fibre = host.querySelector('.ov-glass');
  const pins = host.querySelector('.ov-pins');
  if (fibre) fibre.classList.toggle('flowing', PACE.on && t !== 0);
  if (pins) pins.classList.toggle('flowing', PACE.on && PACE.linked && t > 0);
}

/* The two rates on the fibre line, and the Switch part: every second from
   the tick, so the figures are set where they stand rather than redrawn. */
function paintRates(r) {
  const rateText = (v) => (v === null || v === undefined ? 'measuring' : bytes(v) + '/s');
  const line = $('#overview .ov-glass');
  if (line) {
    reconcile(line, ...(r && r.down !== null && r.up !== null
      ? [el('span', 'ov-rate down', '\u2193 ' + bytes(r.down) + '/s'),
        el('span', 'ov-rate up', '\u2191 ' + bytes(r.up) + '/s')]
      : []));
  }
  const vals = document.querySelectorAll('#overview .ov-switch .ov-val');
  if (vals.length >= 2 && r) {
    /* Set only when it changed, so a selected figure that did not is kept. */
    const set = (n, t) => { if (n.textContent !== t) n.textContent = t; };
    set(vals[0], '\u2193 ' + rateText(r.down));
    set(vals[1], '\u2191 ' + rateText(r.up));
  }
  pace($('#overview'), r);
}

/* The tick: what /api/ponload said, drawn now. A first read draws nothing.
   Its ONU state, when it has one, is newer than the last status poll's, so
   the lines follow it; loss of signal and the host link stay those of the
   poll. */
function liveFibreRates(p) {
  const r = liveRates(p);
  const m = /\((O\d)\)/.exec((p && p.onu_state) || '');
  if (m) PACE.on = m[1] === 'O5' && !PACE.los;
  if (r) paintRates(r);
  return r;
}

/* One part: a button, so the keyboard reaches it, with a name, up to two
   figure lines and a status dot. `go` is where a click takes you. */
function part(cls, name, lines, verdict, go) {
  const b = el('button', 'ov-part ' + cls);
  b.type = 'button';
  b.dataset.k = cls;
  const head = el('span', 'ov-name');
  head.append(el('i', 'dot ' + (verdict || 'none')), document.createTextNode(name));
  b.append(head);
  /* The first line is the figure of the part, the rest say more about it. */
  lines.forEach(([text, extra], i) => b.append(el('span', 'ov-val' + (extra ? ' ' + extra : i === 0 ? ' ov-main' : ''), text)));
  b.addEventListener('click', go);
  return b;
}

const scrollTo = (sel) => () => {
  const t = $(sel);
  if (!t) return;
  t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  t.classList.remove('ov-flash');
  void t.offsetWidth;
  t.classList.add('ov-flash');
};
const goTo = (hash) => () => { location.hash = hash; };

/*
 * f: what renderStatus already worked out (rx and tx with their meter
 * verdicts, module temperature, ONU state, LOS) plus the raw /api/status
 * members this view reads itself.
 */
function renderOverview(f) {
  const host = $('#overview');
  if (!host) return;

  const rxv = f.rx.value;
  const fibre = el('button', 'ov-fibre ov-part');
  fibre.type = 'button';
  fibre.dataset.k = 'ov-fibre';
  const fhead = el('span', 'ov-name');
  fhead.append(el('i', 'dot ' + f.rx.verdict), document.createTextNode('Fibre'));
  const fval = el('span', 'ov-big');
  fval.append(el('span', 'num', rxv === null ? '—' : signed(rxv, 1)), el('span', 'unit', 'dBm'));
  fibre.append(fhead, fval, el('span', 'ov-val ov-sub', f.los ? 'Loss of signal' : 'Light in'));
  /* The fibre carries both directions: what the laser sends is the other
     half of it, said here as well as in the Optics part: a second figure
     with its name, under the first and smaller than it. */
  if (f.tx.value !== null) {
    /* The same pair as light in, a figure and its name, one size down. */
    const out = el('span', 'ov-big ov-out');
    out.append(el('span', 'num', signed(f.tx.value, 2)), el('span', 'unit', 'dBm'));
    fibre.append(out, el('span', 'ov-val ov-sub', 'Light out'));
  }
  fibre.addEventListener('click', scrollTo('#rx'));

  const txv = f.tx.value;
  const optics = part('ov-optics', 'Optics', [
    [txv === null ? 'Laser —' : `Laser ${signed(txv, 2)} dBm`],
    [f.temp === null ? 'Module —' : `Module ${signed(f.temp, 1)} °C`],
    ['↓ 1490 nm  ↑ 1310 nm', 'ov-sub'],
  ], f.tx.verdict, scrollTo('#tx'));

  const busy = cpuBusy(f.st.cpu);
  const cpu = part('ov-cpu', 'CPU', [[busy === null ? 'measuring' : busy.toFixed(0) + ' % busy']],
    busy === null ? 'none' : busy > 90 ? 'warn' : 'ok', scrollTo('#stickblock'));

  const total = kb(f.st.mem_total);
  const avail = kb(f.st.mem_avail);
  const mem = part('ov-mem', 'Memory', [
    [avail === null ? '—' : mib(avail) + ' free'],
    ...(total === null ? [] : [['of ' + mib(total), 'ov-sub']]),
  ], avail === null ? 'none' : avail < 4 * 1048576 ? 'warn' : 'ok', scrollTo('#stickblock'));

  const onuId = /^\s*(\d+)/.exec(f.st.onu_id || '');
  const gpon = part('ov-gpon', 'GPON', [
    [f.state ? `${f.state} ${STATE_NAMES[f.state] || ''}`.trim() : 'No state'],
    [onuId ? 'ONU-ID ' + onuId[1] : 'ONU-ID —', 'ov-sub'],
  ], !f.state ? 'none' : f.state === 'O5' ? 'ok' : 'bad', scrollTo('#ladder'));

  const r = pickRates(fibreRates(f.st.raw_counters));
  const rateText = (v) => (v === null || v === undefined ? 'measuring' : bytes(v) + '/s');
  const sw = part('ov-switch', 'Switch', [
    ['↓ ' + rateText(r && r.down)],
    ['↑ ' + rateText(r && r.up)],
  ], r ? 'ok' : 'none', scrollTo('#flow'));

  const link = typeof f.st.host_link === 'string' ? f.st.host_link.trim() : '';
  const linked = link === '1' ? true : link === '0' ? false : null;
  const mode = typeof f.st.host_mode === 'string' && f.st.host_mode.trim()
    ? serdesShort(f.st.host_mode.trim()) : null;
  const lane = part('ov-lane', 'Host lane', [
    [mode || '—'],
  ], linked === null ? 'none' : linked ? 'ok' : 'bad', goTo('config/network'));
  const router = part('ov-router', 'Router', [
    [linked === null ? '—' : linked ? 'Linked' : 'No link'],
  ], linked === null ? 'none' : linked ? 'ok' : 'bad', goTo('config/network'));

  const soc = el('div', 'ov-soc');
  const chip = f.chip && typeof f.chip.celsius === 'number' ? ` ${signed(f.chip.celsius, 0)} °C` : '';
  soc.append(el('span', 'ov-label', 'SoC' + chip), cpu, mem, gpon, sw);

  const stick = el('div', 'ov-stick');
  stick.append(el('span', 'ov-label ov-stick-label', 'The stick'), optics, soc, lane);

  /* The fibre between the wall and the stick carries what the Switch part
     counts on its fibre side: the two rates sit on the line, down above it
     and up below, and the line moves while the ONU is in service. The same
     figures are in the Switch part, so the line stays out of the way of a
     screen reader. */
  PACE = { on: f.state === 'O5' && !f.los, los: !!f.los, linked: linked === true };
  const fibreLine = el('div', 'ov-line ov-glass' + (PACE.on && totalRate(r) !== 0 ? ' flowing' : ''));
  fibreLine.setAttribute('aria-hidden', 'true');
  if (r && r.down !== null && r.up !== null) {
    fibreLine.append(el('span', 'ov-rate down', '\u2193 ' + bytes(r.down) + '/s'),
      el('span', 'ov-rate up', '\u2191 ' + bytes(r.up) + '/s'));
  }
  const pins = el('div', 'ov-line ov-pins' + (PACE.on && PACE.linked && totalRate(r) > 0 ? ' flowing' : ''));
  pins.setAttribute('aria-hidden', 'true');
  /* Built whole, then laid over what is on screen: only text and classes
     change from one poll to the next (reconcile in dom.js). */
  reconcile(host, fibre, fibreLine, stick, pins, router);
  pace(host, r);
}

export { renderOverview, cpuBusy, liveFibreRates };
