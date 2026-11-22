/*
 * The data the page renders from, and the three questions asked of it: where a
 * value came from, what applying it costs, and whether the firmware is
 * currently ignoring it.
 *
 * One module because every other one reads it and the bootstrap fills it once.
 * Held behind an object rather than exported as bare `let`s: the bootstrap
 * REPLACES these (SCHEMA is reassigned, not appended to), and a destructured
 * import would capture the old empty array.
 */

import { el } from './dom.js';

const S = {
  SCHEMA: [], VALUES: {}, META: {}, CONS: {}, DEFAULTS: {}, BASELINE: {},
  /* mask name -> [{ bit, feature, module }], from /api/features. */
  FEATURES: {},
  /* name -> { apply, action, pair, reader, note }, from /api/settings: what
     THIS image does with the key. Empty on an image without the table, and
     then every key is offered as before. */
  SETTINGS: {},
  /* /api/firmware, for the switch files and the lan-ip override. */
  FW: {},
  /* Set once a reboot is asked for: the page follows it, and polls nothing else. */
  REBOOTING: false,
};

/*
 * The four apply classes, as the page labels them. The names are the ones
 * docs/SETTINGS.md in odi-oss uses (LIVE, SERVICE RESTART, ...), in sentence
 * case, so the doc and the page say the same words.
 *
 * They are ordered by what they cost, and the page draws that order: one to
 * four bars on every badge, in the save bar and in the confirmations alike,
 * so the price of a change reads the same wherever it is shown.
 */
const CLASS_LABEL = {
  live: 'Live',
  restart: 'Service restart',
  internet: 'Interrupts internet',
  reboot: 'Reboot',
};
const CLASS_RANK = { live: 1, restart: 2, internet: 3, reboot: 4 };
/* What each one means, in the words the legend and the tooltips use. */
const CLASS_MEANS = {
  live: 'takes effect at once',
  restart: 'a daemon restarts, internet stays up',
  internet: 'internet drops while the ONU ranges again',
  reboot: 'read only at boot',
};
/* The ones that ask before they act. */
const CLASS_CONFIRMS = new Set(['reboot', 'internet']);

/* The badge, one markup for every place a cost is shown. */
function costBadge(cls, text) {
  const b = el('span', 'cost cost-' + cls);
  /* The words in their own span, so a row can show the bars alone. */
  b.append(el('i', 'bars'), el('span', 'cost-text', text || CLASS_LABEL[cls] || cls));
  if (CLASS_MEANS[cls]) b.title = CLASS_LABEL[cls] + ': ' + CLASS_MEANS[cls];
  return b;
}

/* Whether this image says which keys it reads. */
function imageAware() {
  return Object.keys(S.SETTINGS).length > 0;
}

/* The settings row for a key, or null: a key this image does not read. */
function settingOf(name) {
  return S.SETTINGS[name] || null;
}

/* The ONU identity keys, which omcid reports only while its switch is on. */
const IDENTITY_SWITCH = 'omci-identity.on';
function identitySwitchOn() {
  return Boolean((S.FW.switches || {})[IDENTITY_SWITCH]);
}

/* Pending edits, keyed by name. Kept out of the DOM so switching tabs or
   re-filtering cannot silently drop a change the user has typed -- and read
   back by renderValue, so a re-render shows the edit rather than the stored
   value. */
const EDITS = new Map();

/*
 * Where a value came from.
 *
 * The image ships only ten defaults in /etc/config_default*.xml; the rest are
 * built into the MIB with no read-only way to read them out. So a key is judged
 * against the image default where one exists, and otherwise against a baseline
 * captured from a stick considered correct. Anything with neither reference is
 * left unlabelled rather than guessed at.
 */
function provenance(row, raw) {
  const name = row.name;
  if (name in S.DEFAULTS) {
    return raw === S.DEFAULTS[name]
      ? { cls: 'default', label: 'image default' }
      : { cls: 'changed', label: 'changed', was: S.DEFAULTS[name], from: 'image default' };
  }
  if (name in S.BASELINE) {
    return raw === S.BASELINE[name]
      ? null
      : { cls: 'changed', label: 'changed', was: S.BASELINE[name], from: 'baseline' };
  }
  return null;
}

/* The apply class, preferring the derived one over the schema's. */
function applyOf(row) {
  return (S.CONS[row.name] || {}).apply || row.apply || 'unknown';
}

/*
 * Whether a key's `depends` condition holds. The firmware ignores some keys
 * unless others are set a particular way — VLAN_MANU_TAG_VID is applied only
 * when VLAN_CFG_TYPE=1 and VLAN_MANU_MODE=1, by omcid here as by omci_app on
 * the stock firmware. Saying so is more useful than showing a value that
 * looks live and is not.
 *
 * Judged on the values a Save would leave, pending edits included, so
 * choosing VLAN config mode 1 unlocks the VLAN ID before anything is saved.
 */
function dependsUnmet(row) {
  const m = S.META[row.name];
  if (!m || !m.depends) return null;
  const unmet = m.depends.split('&').filter((c) => {
    const [k, v] = c.split('=');
    return (EDITS.has(k) ? EDITS.get(k) : S.VALUES[k]) !== v;
  });
  return unmet.length ? unmet : null;
}

/* Whether another key's `depends` names this one. */
function gatesOthers(name) {
  return Object.values(S.META).some((m) => m.depends
    && m.depends.split('&').some((c) => c.split('=')[0] === name));
}

/*
 * Drop the pending edits of keys the firmware would ignore. A key turns
 * ignored when the one gating it is changed back (VLAN ID typed, then config
 * mode set to 0), and an edit to it would be saved for nothing.
 */
function dropIgnoredEdits() {
  for (const k of [...EDITS.keys()]) {
    const row = S.SCHEMA.find((r) => r.name === k);
    if (row && dependsUnmet(row)) EDITS.delete(k);
  }
}


/*
 * The VLAN the stick tags upstream with, or null when it adds no tag: omcid
 * builds the manual tag only with VLAN_CFG_TYPE=1, VLAN_MANU_MODE=1 and both a
 * VLAN ID and a priority, as omci_app does on the stock firmware.
 */
function vlanTag(v) {
  const set = (k) => v[k] !== undefined && v[k] !== '';
  return v.VLAN_CFG_TYPE === '1' && v.VLAN_MANU_MODE === '1'
    && set('VLAN_MANU_TAG_VID') && set('VLAN_MANU_TAG_PRI') ? v.VLAN_MANU_TAG_VID : null;
}

/*
 * What a VLAN change can do to the service, or null when it cannot cut it.
 * These keys are LIVE: saving applies them at once, normally with the ONU
 * in O5, so a tag the OLT does not accept stops the traffic with every light
 * still green. `before` is what the stick holds, `after` the same with the edits.
 */
function vlanRisk(before, after) {
  const was = vlanTag(before);
  const now = vlanTag(after);
  if (was === now) return null;
  if (now === null) {
    return `The stick stops tagging VLAN ${was}: upstream frames reach the OLT as the `
      + 'router sends them. On a line whose OLT accepts only tagged frames the service '
      + `stops at once, even with the ONU in O5, unless the router tags VLAN ${was} itself.`;
  }
  if (was === null) {
    return `The stick starts tagging untagged frames with VLAN ${now}. If the OLT does not `
      + 'carry that VLAN the service stops at once, even with the ONU in O5.';
  }
  return `The stick tags with VLAN ${now} instead of ${was}. If the OLT does not carry `
    + `VLAN ${now} the service stops at once, even with the ONU in O5.`;
}

/*
 * Decode an OMCI_CUSTOM_* value against the plugins the image actually ships.
 *
 * These four masks are the least documented settings on the device -- the stick
 * arrives with OMCI_CUSTOM_RDP=4 and upstream has an open issue from 2022
 * asking what that means. It is not a mystery: each bit loads one plugin from
 * lib/features, the plugin's filename IS the bit, and the function it defines
 * is the feature. schema/features.tsv is generated from the image's own ELF
 * symbol tables, so this decode is read off the firmware rather than asserted.
 *
 * The value is DECIMAL. `flash set` accepts nothing else, which is worth
 * knowing before you type 0x102 and watch it store 0.
 *
 * Bits with no plugin are reported rather than dropped: a bit set here that
 * this image cannot load does nothing, and that is the useful thing to see.
 */
function decodeMask(name, value) {
  const rows = S.FEATURES[name];
  if (!rows || !rows.length) return null;

  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = /^0[xX]/.test(raw) ? Number(raw) : Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;

  const known = [];
  const unknown = [];
  let covered = 0;

  for (let b = 0; b < 31; b++) {
    const bit = 1 << b;
    if (!(n & bit)) continue;
    const hit = rows.filter((r) => Number(r.bit) === bit);
    if (hit.length) {
      known.push({ bit, names: hit.map((r) => r.feature) });
      covered |= bit;
    } else {
      unknown.push(bit);
    }
  }
  return { n, known, unknown, covered };
}

/*
 * Whether the page is only the password form: the built-in admin / admin is
 * in force (no confd.auth, or a safe-mode boot) and nobody has saved a
 * password since confd started. confd says both in /api/firmware; a safe-mode
 * boot keeps defaultauth until the reboot, so authsaved is what opens it.
 */
function pwGate(fw = S.FW) {
  return !!(fw && fw.defaultauth && !fw.authsaved);
}

export {
  S, EDITS, pwGate, provenance, applyOf, dependsUnmet, gatesOthers, dropIgnoredEdits, decodeMask, vlanTag, vlanRisk,
  CLASS_LABEL, CLASS_RANK, CLASS_MEANS, CLASS_CONFIRMS, costBadge, imageAware, settingOf, IDENTITY_SWITCH, identitySwitchOn,
};
