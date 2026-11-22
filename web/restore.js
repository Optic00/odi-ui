/*
 * Restore a configuration backup.
 *
 * Deliberately no new daemon route. The browser reads the file, parses it, and
 * replays it through /api/config -- the same path the Config tab writes
 * through, which already validates every value against the schema, refuses the
 * SerDes keys, demands _confirm=identity for the nine that the line
 * authenticates on, and reads every write back. A dedicated restore endpoint
 * taking a whole XML file would be a way around all of that, and the one key it
 * would let through unchecked is LAN_SDS_MODE -- which is the key that takes
 * ssh and this page with it.
 *
 * It also means a restore is reviewable. The file is diffed against what the
 * device holds and nothing is written until the differences have been shown.
 */

import { $, el, ask } from './dom.js';
import { S } from './state.js';
import { valueProblem, restoreSizeProblem } from './validate.js';
import { isNetKey, netaddrActive, startTrial } from './netaddr.js';
import { isEncrypted, encryptBackup, decryptBackup } from './crypto.js';

/*
 * `flash all` prints the config store as <Value Name="X" Value="Y"/> nested in
 * <Dir> elements. Parsed with a regex rather than DOMParser on purpose: the
 * device emits table rows as sibling <Dir> blocks distinguished by an XML
 * COMMENT (<!--index=1-->), which no XML parser will hand back, and the
 * flat name=value view is all a restore needs.
 */
function parseBackup(text) {
  const out = new Map();
  const re = /<Value\s+Name="([^"]+)"\s+Value="([^"]*)"\s*\/>/g;
  let m;

  while ((m = re.exec(text))) {
    /* Later wins: `flash all` prints hs then cs, and a key present in both is
       the cs one the device actually serves from /api/values. */
    out.set(m[1], m[2]);
  }
  return out;
}

/* What the schema says we may write, and what it costs. */
function classify(backup) {
  const rows = new Map(S.SCHEMA.map((r) => [r.name, r]));
  const plan = { same: [], change: [], identity: [], refused: [], unknown: [], invalid: [] };
  /* A backup is judged as a whole: the address and its mask, the second
     address and whether it is on are each read from the file first, as the
     daemon reads them from the same request. */
  const ctx = { get: (k) => (backup.has(k) ? backup.get(k) : S.VALUES[k]) };

  for (const [name, value] of backup) {
    const row = rows.get(name);

    if (!row) { plan.unknown.push(name); continue; }
    if (row.writable === 'never') {
      /* Only report it as refused if it would actually have changed
         something -- a backup always contains these, and listing nine
         untouched keys as problems every time trains people to ignore the
         list. */
      if (S.VALUES[name] !== value) plan.refused.push(name);
      continue;
    }
    if (S.VALUES[name] === value) { plan.same.push(name); continue; }
    /* What the daemon will refuse, said now and not after the write. */
    const why = valueProblem(row, value, ctx);
    if (why) { plan.invalid.push([name, value, why]); continue; }
    (row.writable === 'identity' ? plan.identity : plan.change).push([name, value]);
  }
  return plan;
}

const line = (cls, text) => el('div', cls, text);

/* Let the page paint a "working" line before the key derivation holds the thread. */
const paint = () => new Promise((r) => setTimeout(r, 30));

/*
 * Fetch the backup and hand it to the browser, encrypted when a password is
 * given (see crypto.js for the format and how to open it elsewhere). The key
 * derivation runs here, in the page: the stick never sees the password.
 */
async function saveBackup(password) {
  const r = await fetch('/api/backup', { cache: 'no-store' });

  /* A refusal says why in its body (the factory password, a failed dump). */
  if (!r.ok) throw new Error((await r.text()).trim() || 'backup failed: HTTP ' + r.status);
  let bytes = new Uint8Array(await r.arrayBuffer());

  if (!bytes.length) throw new Error('the backup came back empty');
  if (password) {
    await paint();
    bytes = encryptBackup(bytes, password);
  }
  /* Name it for the stick and the day, so a folder of these is still
     readable in six months. */
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');

  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = `odi-config-${location.hostname}-${stamp}.xml${password ? '.enc' : ''}`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  return { size: bytes.length, encrypted: !!password };
}

/*
 * The text of a backup file, or null with the reason shown: a decrypted file
 * is used only if it parses as a backup. CBC cannot tell a wrong password
 * from damage, and one wrong password in 256 passes the padding check.
 */
function backupText(bytes, password, out) {
  const plain = isEncrypted(bytes) ? decryptBackup(bytes, password) : bytes;
  const text = plain ? new TextDecoder().decode(plain) : '';

  if (parseBackup(text).size) return text;
  out.append(line('bad', isEncrypted(bytes)
    ? 'Wrong password, or the file is damaged. Nothing was read.'
    : 'No settings found in that file. A backup looks like <Value Name="..." Value="..."/> — it is what the '
      + 'Download button above produces.'));
  return null;
}

function renderPlan(plan, host) {
  host.textContent = '';
  const n = plan.change.length + plan.identity.length;

  if (!n) {
    host.append(plan.invalid.length
      ? line('bad', 'Nothing in this backup can be restored: every difference is a value the stick would refuse.')
      : line('good', 'This backup matches what the stick already holds. Nothing to restore.'));
    for (const [name, value, why] of plan.invalid)
      host.append(line('warn', `${name} = ${value === '' ? '(empty)' : value} is skipped: ${why}.`));
    return false;
  }

  host.append(line(null, `${plan.change.length} setting${plan.change.length === 1 ? '' : 's'} differ`
    + (plan.identity.length ? `, plus ${plan.identity.length} identity key${plan.identity.length === 1 ? '' : 's'}` : '')
    + `. ${plan.same.length} already match.`));

  const list = el('table', 'data diff');
  const head = el('tr');
  for (const h of ['Setting', 'On the stick', 'In the backup'])
    head.append(el('th', null, h));
  list.append(head);
  const identity = new Set(plan.identity.map(([name]) => name));

  for (const [name, value] of [...plan.change, ...plan.identity]) {
    const tr = el('tr');
    const now = S.VALUES[name];

    const key = el('td', 'mono', name);
    tr.append(key);
    if (identity.has(name)) key.append(el('span', 'tag identity', 'Identity'));

    tr.append(el('td', 'mono was', now === undefined || now === '' ? '(empty)' : now));
    tr.append(el('td', 'mono now', value === '' ? '(empty)' : value));
    list.append(tr);
  }
  const wrap = el('div', 'tablewrap');
  wrap.append(list);
  host.append(wrap);

  for (const [name, value, why] of plan.invalid)
    host.append(line('warn', `${name} = ${value === '' ? '(empty)' : value} is skipped: ${why}.`));
  if (plan.refused.length)
    host.append(line('warn', 'Not restorable, and skipped: ' + plan.refused.join(', ')
      + '. A wrong SerDes mode costs every management path at once, so this '
      + 'daemon refuses those keys however they arrive.'));
  if (plan.unknown.length)
    host.append(line('warn', plan.unknown.length + ' key(s) in the file are not in '
      + "this image's schema and will be skipped."));
  return true;
}

/*
 * Apply in batches. /api/config is per-key -- a refused or invalid key does not
 * stop the others and each gets its own verdict -- so the batch size is only
 * about not building a request larger than the daemon will read.
 */
async function apply(pairs, withIdentity) {
  const results = [];

  for (let i = 0; i < pairs.length; i += 12) {
    const chunk = pairs.slice(i, i + 12);
    const body = new URLSearchParams(chunk);

    if (withIdentity) body.set('_confirm', 'identity');
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const j = await r.json();
    for (const res of j.results || []) results.push(res);
  }
  return results;
}

let PLAN = null;
let BYTES = null;

/* The Backup block: both fields must agree, and an empty one is not a password. */
function wireBackup() {
  const out = $('#backup-out');
  const go = $('#backup-go');

  go.onclick = async () => {
    const pw = $('#backup-pass').value;

    out.textContent = '';
    if (!pw) { out.append(line('bad', 'Enter a password, or use Download without encryption.')); return; }
    if (pw !== $('#backup-pass2').value) { out.append(line('bad', 'The two passwords differ.')); return; }
    go.disabled = true;
    out.append(line(null, 'Encrypting…'));
    try {
      const done = await saveBackup(pw);

      out.textContent = '';
      out.append(line('good', `Encrypted backup saved (${done.size} bytes). Keep the password: it cannot be recovered.`));
    } catch (e) {
      out.textContent = '';
      out.append(line('bad', String(e.message || e)));
    }
    go.disabled = false;
  };
}

function wireRestore() {
  wireBackup();
  const file = $('#restore-file');
  const out = $('#restore-out');
  const go = $('#restore-go');
  const passRow = $('#restore-pass-row');
  const decrypt = $('#restore-decrypt');

  go.disabled = true;

  file.onchange = async () => {
    PLAN = null;
    BYTES = null;
    passRow.hidden = true;
    $('#restore-pass').value = '';
    go.disabled = true;
    out.textContent = '';
    const f = file.files && file.files[0];

    if (!f) return;
    const big = restoreSizeProblem(f.size);
    if (big) { out.append(line('bad', big)); return; }
    BYTES = new Uint8Array(await f.arrayBuffer());
    if (isEncrypted(BYTES)) {
      passRow.hidden = false;
      out.append(line(null, 'This backup is encrypted. Enter its password and press Decrypt.'));
      $('#restore-pass').focus();
      return;
    }
    review();
  };

  /* Decrypt if need be, then the same parse, diff and review for both kinds. */
  const review = () => {
    out.textContent = '';
    const text = backupText(BYTES, $('#restore-pass').value, out);

    if (text === null) return;
    PLAN = classify(parseBackup(text));
    go.disabled = !renderPlan(PLAN, out);
  };

  decrypt.onclick = async () => {
    if (!BYTES) return;
    PLAN = null;
    go.disabled = true;
    out.textContent = '';
    out.append(line(null, 'Decrypting…'));
    await paint();
    review();
  };

  go.onclick = async () => {
    if (!PLAN) return;
    const withIdentity = $('#restore-identity').checked;
    const pairs = [...PLAN.change, ...(withIdentity ? PLAN.identity : [])];

    if (!pairs.length) return;
    /* Identity keys are what the OLT authenticates this ONU by: written onto
       another stick they put two ONUs on the line with one serial. The tick
       box says so, and this asks once more with the keys named. */
    if (withIdentity && PLAN.identity.length
        && !(await ask('Write ' + PLAN.identity.length + ' identity key(s) (' + PLAN.identity.map(([k]) => k).join(', ')
          + ')?\n\nOnly do this onto the stick the backup came from: on another stick the OLT would see '
          + 'the same serial number twice.\n\nContinue?', { action: 'Write identity keys', danger: true }))) return;
    go.disabled = true;
    out.append(line(null, `Writing ${pairs.length} setting(s)…`));

    /* The management addresses go through the trial, not the store: the
       stick keeps the old ones beside the new, and stores them only when the
       new ones answer. */
    const net = netaddrActive() ? pairs.filter(([k]) => isNetKey(k)) : [];
    const results = await apply(net.length ? pairs.filter(([k]) => !isNetKey(k)) : pairs, withIdentity);
    const bad = results.filter((r) => !r.ok);

    out.append(line(bad.length ? 'warn' : 'good',
      `${results.length - bad.length} written, ${bad.length} refused.`));
    for (const r of bad) out.append(line('bad', `${r.name}: ${r.error}`));

    if (!withIdentity && PLAN.identity.length)
      out.append(line('warn', PLAN.identity.length + ' identity key(s) were left '
        + 'alone. Tick the box above to include them — only do that when '
        + 'restoring onto the stick the backup came from.'));

    if (net.length) {
      out.append(line(null, 'The management address keys are tried, not written: the stick moves '
        + 'to them and goes back by itself unless you keep them on the new address.'));
      await startTrial(net, out);
    }

    out.append(line('warn', 'Written, not applied. Each restored key takes effect '
      + 'the way its class on the Config tab says: the addresses are tried when '
      + 'the image has the trial and applied when you save them again there when it does not, '
      + 'the OMCI keys with Apply now, the rest at '
      + 'the next reboot. Keys only the stock firmware reads change nothing here, except OMCI_CUSTOM_ME, whose bit 256 decides whether the VEIP slot applies.'));
  };
}

export { parseBackup, classify, wireRestore, saveBackup, backupText };
