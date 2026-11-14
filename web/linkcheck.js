/*
 * The link check: five stages a line goes through, from light on the fibre to
 * traffic, and one finding for the first stage that fails, with the evidence
 * it rests on.
 *
 * "Not in O5" covers very different faults. An OLT that does not know the
 * serial number leaves the ONU in O3 without an ONU-ID; one that refuses the
 * password ranges it and throws it out again; an O7 is the OLT switching the
 * laser off; a MIB reset loop is OMCI failing after registration; and a line
 * can be provisioned and still carry nothing. Each of those has its own fix,
 * so each gets its own finding instead of one hint for all of them.
 *
 * Everything here is pure: linkCheck() takes the facts, plain values the page
 * already reads (/api/status, `omcicli state`, the GEM port count, the port
 * counters), and returns the stages. make check drives it with each case.
 * A fact the image does not report (the stock firmware has no
 * /proc/odi_gpon and no `omcicli state`) is null, and the stage that needs it
 * says "unknown" rather than guessing.
 */

/* Polls of the Status tab (15 s apart): see trackLink(). */
const STALL_NOT_O5 = 4;
const STALL_IN_O5 = 8;
const IDLE_FAIL = 3;
const FIBRE_PORT = '2';
/* omcid's loop threshold (odi-oss events.c, MIBLOOP_RESETS). */
const LOOP_RESETS = 3;

const STAGES = [
  ['light', 'Light'],
  ['registered', 'Registered'],
  ['omci', 'OMCI with the OLT'],
  ['services', 'Services set up'],
  ['traffic', 'Traffic'],
];

/*
 * `omcicli state` as { state, mibSync, resets }; resets is null on an omcid
 * without the line (before AndreZiviani/odi-oss#393). Null for no answer.
 */
function omciState(raw) {
  if (!raw || !/^onu state\s*:/m.test(raw)) return null;
  const m = (re) => { const r = re.exec(raw); return r ? r : null; };
  const st = m(/^onu state\s*:\s*(O\d)/m);
  const sync = m(/^mib sync\s*:\s*(\d+)/m);
  const r = m(/^mib resets\s*:\s*olt (\d+)\s+local (\d+)\s+olt in last (\d+) s (\d+)\s+loop (yes|no)/m);
  return {
    state: st ? st[1] : null,
    mibSync: sync ? Number(sync[1]) : null,
    resets: r ? {
      olt: Number(r[1]), local: Number(r[2]), windowS: Number(r[3]),
      recent: Number(r[4]), loop: r[5] === 'yes',
    } : null,
  };
}

/* /api/status onu_id: the number, null for none (-1), undefined when the
   image does not report it (the stock firmware). */
function onuIdOf(v) {
  if (v === undefined || v === null || !/^-?\d+$/.test(String(v).trim())) return undefined;
  const n = Number(String(v).trim());
  return n >= 0 && n < 255 ? n : null;
}

/* /api/status alloc_ids, "N id id ...": the count, null when not reported. */
function allocCount(v) {
  if (v === undefined || v === null) return null;
  const m = /^\s*(\d+)/.exec(String(v));
  return m ? Number(m[1]) : null;
}

/* /api/status o7_hold, "keep K held H": a kept Emergency Stop in force. */
const o7Held = (v) => /\bheld 1\b/.test(String(v || ''));

/*
 * The checks, in order. f:
 *   state      'O1'..'O7' or null      los   LOS or LOF asserted
 *   rx         receive power in dBm or null
 *   onuId      the ONU-ID the OLT assigned, null for none, undefined when
 *              the image does not report it
 *   alloc      Alloc-IDs assigned, or null when not reported
 *   o7Held     the stick keeps an OLT disable (GPON_KEEP_DISABLE)
 *   stalled    long enough before O5 that it is not still registering
 *   ranged     since the stall began the line got an ONU-ID or reached O4,
 *              O5 or O6 (true), never did (false), or not tracked (undefined)
 *   omci       omciState(), or null
 *   gem        GEM port network CTPs in the MIB, or null
 *   traffic    { in, out }: bytes on the fibre port since the last sample,
 *              null until there are two samples, undefined when the caller
 *              does not measure it (the setup wizard)
 *   idle       how many samples in a row moved no byte on the fibre port
 */
function linkCheck(f) {
  const out = STAGES.map(([key, name]) => ({ key, name, status: 'wait', evidence: '' }));
  const at = (k) => out.find((s) => s.key === k);
  const done = (k, status, evidence) => { Object.assign(at(k), { status, evidence }); };
  const verdict = (k, cls, text) => ({ stages: out, finding: { stage: k, cls, text } });

  if (!f) {
    for (const s of out) s.status = 'unknown';
    return { stages: out, finding: { stage: null, cls: 'warn', text: 'No answer from the stick yet.' } };
  }

  /* 1. Light. */
  const rxText = f.rx === null || f.rx === undefined ? 'no receive reading' : `receive ${f.rx.toFixed(1)} dBm`;
  if (f.los) {
    done('light', 'fail', 'LOS or LOF asserted, ' + rxText);
    return verdict('light', 'bad', 'No usable light on the fibre (loss of signal or framing). Check the '
      + 'connector, that the fibre is in the right port, and that it is clean: the stick cannot '
      + 'register without light.');
  }
  done('light', 'ok', rxText);

  /* 2. Registered with the OLT. */
  /* null: the image says there is none; undefined: it does not say. */
  const id = f.onuId;
  if (f.state === 'O7') {
    done('registered', 'fail', 'O7' + (f.o7Held ? ', disable kept across restarts' : ''));
    return verdict('registered', 'bad', 'The OLT disabled this ONU (O7, emergency stop): the laser is off '
      + 'until the OLT enables it again. That is the operator\'s decision, not a setting here; '
      + (f.o7Held ? 'GPON_KEEP_DISABLE keeps it across restarts of the stick.' : 'ask them why.'));
  }
  if (f.state !== 'O5') {
    const where = (f.state || 'no state')
      + (id === null ? ', no ONU-ID' : typeof id === 'number' ? `, ONU-ID ${id}` : '');
    if (!f.stalled) {
      done('registered', 'wait', where);
      return verdict('registered', 'warn', 'Registering with the OLT…');
    }
    done('registered', 'fail', where);
    /*
     * The driver forgets the ONU-ID on every fall back to O2/O3, so the ID
     * seen now does not tell a refused serial from a refused password. What
     * does is whether the line got further since it stalled (f.ranged: an
     * ONU-ID, O4, O5 or O6 seen): an OLT that does not know the serial never
     * assigns an ID; one that refuses the password ranges the ONU, asks for
     * the password in O5 and deactivates it. The LOID is checked later, over
     * OMCI, so it does not keep a line from registering.
     */
    if (f.state === 'O4') {
      return verdict('registered', 'bad', 'The OLT assigned an ONU-ID but ranging does not complete (O4). '
        + 'That is rarely a setting: look at the event=onu_state lines in the log for what ends each try.');
    }
    if (f.ranged === true) {
      return verdict('registered', 'bad', 'The OLT ranges this stick and then drops it again before it can '
        + 'stay registered. With light on the fibre that usually means it refuses the PLOAM password '
        + '(GPON_PLOAM_PASSWD): check it with your ISP.');
    }
    if (f.ranged === false && (f.state === 'O2' || f.state === 'O3')) {
      return verdict('registered', 'bad', 'The OLT has not assigned an ONU-ID since the line stalled: it most '
        + 'likely does not know this serial number (GPON_SN). Check it with your ISP.');
    }
    return verdict('registered', 'bad', 'Still not operational. With light on the fibre, being stuck before '
      + 'O5 usually means a wrong serial number or PLOAM password: check them with your ISP.');
  }
  done('registered', 'ok', 'O5' + (typeof id === 'number' ? `, ONU-ID ${id}` : '')
    + (f.alloc === null || f.alloc === undefined ? '' : `, ${f.alloc} Alloc-ID${f.alloc === 1 ? '' : 's'}`));

  /* 3. OMCI with the OLT. */
  const o = f.omci || null;
  const r = o && o.resets;
  /* omcid keeps the loop flag until a whole window passes without a reset,
     so a loop that has just stopped still has it with fewer recent resets:
     that is said, not failed. */
  const looping = r && r.loop && r.recent >= LOOP_RESETS;
  if (looping) {
    done('omci', 'fail', `${r.recent} MIB resets from the OLT in ${Math.round(r.windowS / 60)} min`);
    return verdict('omci', 'bad', 'MIB reset loop: the OLT keeps throwing away what it provisioned and '
      + 'starting again. It usually does not accept something it reads: check the identity (equipment '
      + 'ID, vendor and product codes, software versions) and the unknown classes the stick reports, '
      + 'and the before= field of the event=mib_reset lines in the log.');
  }
  if (!o) {
    done('omci', 'unknown', 'omcid state not available');
  } else if (o.mibSync === 0 && !f.gem) {
    done('omci', f.stalled ? 'fail' : 'wait', 'MIB data sync 0, nothing provisioned'
      + (r ? `, ${r.olt} MIB reset${r.olt === 1 ? '' : 's'} from the OLT` : ''));
    if (!f.stalled) return verdict('omci', 'warn', 'Operational. Waiting for the OLT to provision over OMCI…');
    return verdict('omci', 'bad', 'Registered, but the OLT has not provisioned anything over OMCI. '
      + 'Some OLTs do that only for an ONU whose identity they expect: check the equipment ID and '
      + 'the vendor and product codes against what your ISP supports.');
  } else {
    done('omci', r && r.loop ? 'wait' : 'ok', `MIB data sync ${o.mibSync === null ? '?' : o.mibSync}`
      + (r ? `, ${r.recent} OLT reset${r.recent === 1 ? '' : 's'} in ${Math.round(r.windowS / 60)} min` : '')
      + (r && r.loop ? ', the loop flag clears after a quiet window' : ''));
  }

  /* 4. Services set up. */
  if (f.gem === null || f.gem === undefined) {
    done('services', 'unknown', 'GEM ports not read');
  } else if (f.gem === 0) {
    done('services', f.stalled ? 'fail' : 'wait', 'no GEM port in the MIB'
      + (f.alloc === null || f.alloc === undefined ? '' : `, ${f.alloc} Alloc-IDs`));
    if (!f.stalled) return verdict('services', 'warn', 'Operational. Waiting for the OLT to set up the services…');
    return verdict('services', 'bad', 'The OLT has not set up any service (no GEM port). Without one '
      + 'nothing can pass: the order may not be active yet on the operator\'s side.');
  } else {
    done('services', 'ok', `${f.gem} GEM port${f.gem === 1 ? '' : 's'}`);
  }

  /* 5. Traffic. */
  const t = f.traffic;
  if (t === undefined) {
    done('traffic', 'unknown', 'not measured here');
    return verdict(null, 'good', 'Operational. The line is registered.');
  }
  if (!t) {
    done('traffic', 'wait', 'measuring');
    return verdict('traffic', 'good', 'Operational. Measuring traffic…');
  }
  const moved = (t.in || 0) + (t.out || 0);
  if (moved > 0) {
    done('traffic', 'ok', 'bytes in and out on the fibre port');
    return verdict(null, 'good', 'Operational. The line is registered, provisioned and carrying traffic.');
  }
  done('traffic', (f.idle || 0) >= IDLE_FAIL ? 'fail' : 'wait', 'no byte on the fibre port since the last sample');
  if ((f.idle || 0) < IDLE_FAIL) return verdict('traffic', 'good', 'Operational. No traffic in the last sample.');
  return verdict('traffic', 'warn', 'Provisioned, but nothing crosses the fibre port. Check the VLAN '
    + 'setting (the stick or the router tags) against what your ISP expects, and that the router '
    + 'sends anything at all.');
}

/*
 * The Status tab's side of it: one poll in, the facts linkCheck() needs out,
 * and the tracker for the next poll. Pure; the caller keeps T between polls.
 *   T     the last tracker, or null on the first poll
 *   p     { facts: lineFacts(), st: the /api/status answer, ports: the
 *           parsed port counters, omci: omciState() or null, gem: the GEM
 *           port count or undefined, at: Date.now() }
 * stalled: 4 polls (a minute at 15 s) not in O5, or 8 polls in O5 for the
 * OMCI and services stages; an OLT takes seconds for each, so either is far
 * past a registration still under way.
 */

function trackLink(T, p) {
  const prev = T || { inO5: 0, notO5: 0, ports: null, idle: 0, ranged: false, o3o4: null };
  const o5 = p.facts && p.facts.state === 'O5';
  const st0 = p.st || {};
  /* The driver counts every O3 to O4 (onu_transitions): a count that moved
     since the last poll is a ranging attempt the poll did not see. */
  /* The odi-oss driver prints only the transitions that happened: no line
     is a count of 0 there. The stock image reports none of this. */
  const odi = st0.onu_id !== undefined;
  const o3o4 = /^\s*\d+\s*$/.test(String(st0.o3_o4 ?? '')) ? Number(st0.o3_o4) : (odi ? 0 : null);
  const got = typeof onuIdOf(st0.onu_id) === 'number'
    || ['O4', 'O5', 'O6'].includes(p.facts && p.facts.state)
    || (o3o4 !== null && prev.o3o4 !== null && o3o4 > prev.o3o4);
  const n = {
    inO5: o5 ? prev.inO5 + 1 : 0,
    notO5: o5 ? 0 : prev.notO5 + 1,
    ports: p.ports && p.ports[FIBRE_PORT] ? p.ports[FIBRE_PORT] : null,
    idle: prev.idle,
    /* From the last O5 on: a drop out of O5 counts as having got further. */
    ranged: got || (!o5 && prev.ranged),
    o3o4,
  };
  let traffic = null;
  if (n.ports && prev.ports) {
    const d = (k) => Number(n.ports[k] || 0) - Number(prev.ports[k] || 0);
    const din = d('ifInOctets');
    const dout = d('ifOutOctets');
    /* A negative delta is a counter reset between polls: no sample. */
    if (din >= 0 && dout >= 0) traffic = { in: din, out: dout };
  }
  if (traffic) n.idle = traffic.in + traffic.out > 0 ? 0 : prev.idle + 1;
  if (!o5) n.idle = 0;
  if (!p.facts) return { T: n, f: null };
  const st = p.st || {};
  return {
    T: n,
    f: {
      ...p.facts,
      onuId: onuIdOf(st.onu_id),
      alloc: allocCount(st.alloc_ids),
      o7Held: o7Held(st.o7_hold),
      stalled: o5 ? n.inO5 >= STALL_IN_O5 : n.notO5 >= STALL_NOT_O5,
      ranged: odi ? n.ranged : undefined,
      omci: p.omci || null,
      gem: p.gem,
      traffic,
      idle: n.idle,
    },
  };
}

export { linkCheck, trackLink, omciState, onuIdOf, allocCount, o7Held, STAGES, IDLE_FAIL };
