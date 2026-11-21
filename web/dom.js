/*
 * The four things every other module needs: find an element, make one, show an
 * error, fetch JSON.
 *
 * `get` throws on a non-2xx rather than returning a body, so a caller cannot
 * accidentally render an error page as data.
 */

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/*
 * Give `host` the children `nodes`, keeping every node already there that is
 * the same thing in the same place: same tag and same data-k (a part sets
 * data-k when two siblings of one tag do different things on a click). A kept
 * node takes over the class, `hidden` and title of the new one, the only
 * attributes the renderers change between polls, and its text is updated in
 * place. A poll that rebuilt the Status view every 15 s took the keyboard
 * focus off the part it was on and cleared a text selection; this keeps both.
 * Listeners stay those of the kept node, which is why data-k tells parts
 * apart.
 */
function reconcile(host, ...nodes) {
  const a = host.childNodes;
  nodes.forEach((n, i) => {
    const o = a[i];
    if (!o) host.append(n);
    else if (o.nodeType === 3 && n.nodeType === 3) {
      if (o.textContent !== n.textContent) o.textContent = n.textContent;
    } else if (o.nodeType === 1 && n.nodeType === 1 && o.tagName === n.tagName
               && o.dataset.k === n.dataset.k) {
      if (o.className !== n.className) o.className = n.className;
      if (o.hidden !== n.hidden) o.hidden = n.hidden;
      if (o.title !== n.title) o.title = n.title;
      reconcile(o, ...n.childNodes);
    } else o.replaceWith(n);
  });
  while (a.length > nodes.length) a[a.length - 1].remove();
}

function fail(e) {
  const box = $('#err');
  box.textContent = String(e && e.message ? e.message : e);
  box.hidden = false;
}

/* The server says what may be kept: the image files come with a tag and are
   revalidated (a 304 when unchanged), and what the device holds is no-store.
   Forcing no-store here threw the tags away.
   `timeout` (ms) gives up on a request whose answer, headers or body, does
   not arrive in time, so a caller that waits for it is not stuck for good. */
async function get(path, { timeout = 0 } = {}) {
  const ctl = timeout ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeout) : null;
  try {
    const r = await fetch(path, ctl ? { signal: ctl.signal } : undefined);
    if (!r.ok) {
      /* A refusal says why in {"error": ...}: show that, not only the status. */
      let why = '';
      try { why = (await r.json()).error || ''; } catch (e) { /* not JSON */ }
      throw new Error(path + ' -> HTTP ' + r.status + (why ? ': ' + why : ''));
    }
    return await r.json();
  } catch (e) {
    if (ctl && ctl.signal.aborted) throw new Error(path + ' -> no answer in ' + Math.round(timeout / 1000) + ' s');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* `fn` once at a time: a call while one is still running does nothing and
   returns undefined. For polls, where the next tick is the retry. */
function oneAtATime(fn) {
  let busy = false;
  return async (...args) => {
    if (busy) return undefined;
    busy = true;
    try { return await fn(...args); } finally { busy = false; }
  };
}

/*
 * Light or dark. The page follows prefers-color-scheme until the user picks
 * one; the pick is data-theme on <html> (which style.css lets override the
 * media query) and is kept in localStorage under THEME_KEY. index.html reads it
 * back in the head, before first paint. Storage can be absent or throw, and
 * then the choice lasts for the page only.
 */
const THEME_KEY = 'odi-theme';
const currentTheme = () => {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light' : 'dark';
};
function paintThemeToggle() {
  const to = currentTheme() === 'dark' ? 'light' : 'dark';
  const b = $('#themetoggle');
  b.setAttribute('aria-label', 'Switch to ' + to + ' mode');
  b.setAttribute('title', 'Switch to ' + to + ' mode');
  /* setAttribute, not .hidden: an SVG element has no hidden property. */
  for (const [id, on] of [['#ico-sun', to === 'light'], ['#ico-moon', to === 'dark']]) {
    if (on) $(id).removeAttribute('hidden'); else $(id).setAttribute('hidden', '');
  }
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* not persisted */ }
  paintThemeToggle();
}
function wireTheme() {
  $('#themetoggle').addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  /* Until a pick is made the icon has to follow the browser too. */
  if (typeof matchMedia === 'function') {
    const mq = matchMedia('(prefers-color-scheme: light)');
    if (mq.addEventListener) mq.addEventListener('change', paintThemeToggle);
  }
  paintThemeToggle();
}

const bytes = (n) => {
  n = Number(n || 0);
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  /* At most two decimals at any scale. A rate is a byte count over a
     fractional interval, so below 1 kB it used to print the float whole
     (123.456789 B/s). */
  return (i ? n.toFixed(n < 10 ? 2 : 1) : String(Math.round(n * 100) / 100)) + ' ' + u[i];
};

/*
 * The ? beside a field name. It shows or hides `helpBox`, which starts
 * closed. Full help (data-help="full" on <html>) shows every box at once
 * without changing what each ? has open on its own.
 */
function createHelpToggle(helpBox, fieldLabel) {
  const button = el('button', 'help-toggle', '?');
  button.type = 'button';
  button.title = 'Help';
  button.setAttribute('aria-label', 'Help: ' + fieldLabel);
  button.setAttribute('aria-expanded', 'false');
  if (helpBox.id) button.setAttribute('aria-controls', helpBox.id);
  button.addEventListener('click', () => {
    const isOpen = !helpBox.classList.contains('open');
    helpBox.classList.toggle('open', isOpen);
    button.setAttribute('aria-expanded', String(isOpen));
  });
  return button;
}

/*
 * Full help: every field's help open at once, from the header button, which
 * only the Config tab shows (app.js route()). It is data-help="full" on
 * <html> (style.css opens every .s-helpbox under it) and is kept in
 * localStorage under HELP_KEY, read back in the head like the theme.
 */
const HELP_KEY = 'odi-fullhelp';
const isFullHelpOn = () => document.documentElement.dataset.help === 'full';
function setFullHelp(enabled) {
  if (enabled) document.documentElement.dataset.help = 'full';
  else delete document.documentElement.dataset.help;
  try { localStorage.setItem(HELP_KEY, enabled ? '1' : '0'); } catch (error) { /* not persisted */ }
  $('#helptoggle').setAttribute('aria-pressed', String(enabled));
}
function wireHelp() {
  $('#helptoggle').addEventListener('click', () => setFullHelp(!isFullHelpOn()));
  $('#helptoggle').setAttribute('aria-pressed', String(isFullHelpOn()));
}

/*
 * The question before a change, in a dialog of the page (#ask-dialog) rather
 * than in confirm() of the browser: the cost badge heads it as it does everywhere
 * else, and the button says what it does. `text` is the question as confirm()
 * took it: a first paragraph that is a question becomes the heading, and a
 * closing "Continue?" goes, since the button asks it. `badge` is a cost badge
 * element and `badgeText` its words, for confirm(), which still asks where the
 * page has no modal dialog (scripts/web-check.mjs). `back` names the other
 * button. Resolves true or false; Escape and that button are false.
 */
function ask(text, { action = 'Continue', back = 'Cancel', danger = false, badge = null, badgeText = '' } = {}) {
  const dlg = $('#ask-dialog');
  if (!dlg || typeof dlg.showModal !== 'function') {
    return Promise.resolve(confirm((badgeText ? badgeText + '\n\n' : '') + text));
  }
  const paras = String(text).split('\n\n').map((p) => p.trim()).filter(Boolean);
  if (paras.length > 1 && paras[paras.length - 1] === 'Continue?') paras.pop();
  if (paras.length) paras[paras.length - 1] = paras[paras.length - 1].replace(/\s*Continue\?$/, '');
  const title = paras.length > 1 && paras[0].endsWith('?') ? paras.shift() : '';

  const head = $('#ask-head');
  head.textContent = '';
  if (badge) head.append(badge);
  if (title) head.append(el('h2', null, title));
  head.hidden = !badge && !title;
  /* A hidden heading names nothing: the dialog is then named by its action. */
  if (head.hidden) { dlg.removeAttribute('aria-labelledby'); dlg.setAttribute('aria-label', action); }
  else { dlg.removeAttribute('aria-label'); dlg.setAttribute('aria-labelledby', 'ask-head'); }
  const body = $('#ask-body');
  body.textContent = '';
  for (const p of paras) if (p) body.append(el('p', null, p));
  const ok = $('#ask-ok');
  const cancel = $('#ask-cancel');
  ok.textContent = action;
  cancel.textContent = back;
  ok.className = danger ? 'danger' : 'primary';

  return new Promise((resolve) => {
    const done = (v) => {
      ok.onclick = cancel.onclick = dlg.oncancel = null;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    /* Escape closes a modal dialog by itself: that is a no, too. */
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
    dlg.showModal();
    /* Enter on a focused button presses it: on a change that cannot be taken
       back that should be Cancel. */
    (danger ? cancel : ok).focus();
  });
}

/*
 * Run `fn` for a button that writes something, one at a time: the button is
 * off from the click until `fn` has settled, and a click while it is off does
 * nothing. Returns whether `fn` ran.
 */
async function once(btn, fn) {
  const b = typeof btn === 'string' ? $(btn) : btn;
  if (b.disabled) return false;
  b.disabled = true;
  try { await fn(); } finally { b.disabled = false; }
  return true;
}

export { $, el, reconcile, fail, get, oneAtATime, bytes, ask, once, currentTheme, setTheme, wireTheme, createHelpToggle, setFullHelp, wireHelp, THEME_KEY, HELP_KEY };
