// Accounts and saving to the cloud (Supabase: email + password sign-in, one private row per account).
// What saves: your settings (format, scoring, TE premium, custom scoring…), your linked Sleeper league, your own
// rankings (myranks.js) and the boards you pasted (boards.js). Everything also stays in this browser, so the app works
// signed out or offline; signed in, each change is saved to your account a moment later and loads on any device.
import { CLOUD } from './cloud-config.js';
import { S } from './store.js';
import { KEY as RANKS } from './myranks.js';

const META = 'dl.cloud.v1', APP = 'dynastylab.v1', BOARDS = 'dl.boards.v1';
export const enabled = () => !!(CLOUD.url && CLOUD.key);

const readLS = (k, d = null) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch { return d; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };
let meta = readLS(META, {}); // { session, dirty, localUpdated, synced, syncedUser }
const saveMeta = () => writeLS(META, meta);

export const user = () => meta.session?.user || null;

// ---------- status for the header (saving / saved / error) ----------
let status = { state: 'idle' };
const listeners = new Set();
export const onStatus = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const getStatus = () => status;
const setStatus = s => { status = s; listeners.forEach(fn => fn(s)); };

// ---------- Supabase REST ----------
const base = () => CLOUD.url.replace(/\/+$/, '');
async function api(path, { method = 'GET', body, auth = false, headers = {} } = {}) {
  const h = { apikey: CLOUD.key, 'Content-Type': 'application/json', ...headers };
  if (auth) { await fresh(); h.Authorization = `Bearer ${meta.session.access_token}`; }
  let r;
  try { r = await fetch(base() + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }); }
  catch { throw new Error('Couldn’t reach the account server. Check your connection.'); }
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) {
    const e = new Error(friendly(j?.msg || j?.error_description || j?.message || j?.error || `Error ${r.status}`));
    e.status = r.status;
    throw e;
  }
  return j;
}
const friendly = m => ({
  'Invalid login credentials': 'Wrong email or password.',
  'Email not confirmed': 'Confirm your email first: open the link we sent you.',
  'User already registered': 'There’s already an account with that email. Sign in instead.',
}[m] || m);

function setSession(j) {
  meta.session = {
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
    user: j.user ? { id: j.user.id, email: j.user.email } : meta.session?.user || null,
  };
  saveMeta();
}
let refreshing = null;
async function fresh() {
  const s = meta.session;
  if (!s) throw new Error('Not signed in');
  if (s.expires_at - 60 > Date.now() / 1000) return;
  refreshing ||= (async () => {
    const r = await fetch(`${base()}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: CLOUD.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) })
      .catch(() => { throw new Error('Couldn’t reach the account server. Check your connection.'); });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.access_token) { meta.session = null; saveMeta(); setStatus({ state: 'idle' }); throw new Error('Your sign-in expired. Sign in again.'); }
    setSession(j);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

const home = () => location.origin + location.pathname;

/** Create an account. Returns { signedIn } or { confirm } when the project asks new accounts to confirm their email. */
export async function signUp(email, password) {
  const j = await api(`/auth/v1/signup?redirect_to=${encodeURIComponent(home())}`, { method: 'POST', body: { email, password } });
  if (j?.access_token) { setSession(j); await pull({ signIn: true }); return { signedIn: true }; }
  return { confirm: true };
}
export async function signIn(email, password) {
  setSession(await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }));
  await pull({ signIn: true });
}
export async function signOut() {
  try { await api('/auth/v1/logout', { method: 'POST', auth: true }); } catch { /* signed out here either way */ }
  meta.session = null; saveMeta();
  setStatus({ state: 'idle' });
}
export const sendReset = email => api(`/auth/v1/recover?redirect_to=${encodeURIComponent(home())}`, { method: 'POST', body: { email } });
export const setPassword = password => api('/auth/v1/user', { method: 'PUT', auth: true, body: { password } });

/**
 * After the link in a confirmation or password-reset email, Supabase sends you back with the session in the address
 * (#access_token=…&type=signup|recovery). Takes it, cleans the address and returns { type } or { error }, else null.
 */
export async function fromRedirect() {
  const h = location.hash.replace(/^#\/?/, '');
  if (!/(^|&)(access_token|error_description)=/.test(h)) return null;
  const q = new URLSearchParams(h);
  history.replaceState(null, '', `${location.pathname}${location.search}#/`);
  if (q.get('error_description')) return { error: q.get('error_description').replace(/\+/g, ' ') };
  meta.session = { access_token: q.get('access_token'), refresh_token: q.get('refresh_token'), expires_at: Number(q.get('expires_at')) || Math.floor(Date.now() / 1000) + Number(q.get('expires_in') || 3600), user: null };
  try {
    const u = await api('/auth/v1/user', { auth: true });
    meta.session.user = { id: u.id, email: u.email }; saveMeta();
  } catch (e) { meta.session = null; saveMeta(); return { error: e.message }; }
  return { type: q.get('type') || 'signup' };
}

// ---------- what's saved ----------
function collect() {
  const app = readLS(APP, {});
  return {
    v: 1,
    app: { settings: app.settings || {}, sleeperUser: app.sleeperUser || '', sleeperUserId: app.sleeperUserId || null, leagueId: app.leagueId || null },
    boards: readLS(BOARDS, {}), ranks: readLS(RANKS, {}),
  };
}
// first sign-in on a device: keep this browser's boards and rankings next to the account's
function merge(local, remote) {
  const boards = { ...remote.boards };
  for (const [cls, list] of Object.entries(local.boards || {})) {
    const ids = new Set((boards[cls] || []).map(b => b.id));
    boards[cls] = [...(boards[cls] || []), ...list.filter(b => !ids.has(b.id))];
  }
  const ranks = { nfl: { ...(remote.ranks?.nfl || {}) }, college: { ...(remote.ranks?.college || {}) } };
  for (const g of ['nfl', 'college']) for (const [k, v] of Object.entries(local.ranks?.[g] || {})) {
    if (!ranks[g][k] || String(v.updated) > String(ranks[g][k].updated)) ranks[g][k] = v;
  }
  return { v: 1, app: remote.app?.settings && Object.keys(remote.app.settings).length ? remote.app : local.app, boards, ranks };
}
function apply(doc) {
  const app = { ...readLS(APP, {}), ...doc.app };
  writeLS(APP, app); writeLS(BOARDS, doc.boards || {}); writeLS(RANKS, doc.ranks || {});
  S.settings = { ...S.settings, ...(doc.app?.settings || {}) };
  S.sleeperUser = app.sleeperUser || ''; S.sleeperUserId = app.sleeperUserId || null; S.leagueId = app.leagueId || null;
}

// ---------- syncing ----------
let timer = null;
/** Upload this browser's data to your account. */
export async function push(doc = collect()) {
  if (!user()) return;
  clearTimeout(timer);
  const now = new Date().toISOString();
  setStatus({ state: 'saving' });
  try {
    await api('/rest/v1/user_data', { method: 'POST', auth: true, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: { user_id: user().id, data: doc, updated_at: now } });
    meta.dirty = false; meta.synced = now; meta.syncedUser = user().id; saveMeta();
    setStatus({ state: 'saved', at: now });
  } catch (e) { setStatus({ state: 'error', error: e.message }); }
}

/**
 * Bring this browser and your account into step. Your account's data replaces this browser's when it's newer; this
 * browser's is uploaded when it's newer; the first sign-in on a device merges the two. Returns true when the account's
 * data was applied here (callers then reload or redraw).
 */
export async function pull({ signIn = false } = {}) {
  if (!user()) return false;
  const rows = await api(`/rest/v1/user_data?select=data,updated_at&user_id=eq.${encodeURIComponent(user().id)}`, { auth: true });
  const row = rows?.[0];
  if (!row) { await push(); return false; }
  if (signIn || meta.syncedUser !== user().id) {
    const merged = merge(collect(), row.data || {});
    apply(merged); await push(merged); return true;
  }
  if (meta.dirty && meta.localUpdated && meta.localUpdated > row.updated_at) { await push(); return false; }
  if (row.updated_at === meta.synced) { setStatus({ state: 'saved', at: row.updated_at }); return false; }
  apply(row.data || {});
  meta.dirty = false; meta.synced = row.updated_at; saveMeta();
  setStatus({ state: 'saved', at: row.updated_at });
  return true;
}

/** Start syncing: every change made in the app is saved to your account a moment later. */
export function start({ onRemote } = {}) {
  window.addEventListener('dl:changed', () => {
    meta.dirty = true; meta.localUpdated = new Date().toISOString(); saveMeta();
    if (!user() || !enabled()) return;
    clearTimeout(timer);
    setStatus({ state: 'saving' });
    timer = setTimeout(() => push(), 1500);
  });
  // back on the tab: pick up changes made on another device
  let last = Date.now();
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !user() || !enabled() || Date.now() - last < 60e3) return;
    last = Date.now();
    try { if (await pull()) onRemote?.(); } catch { /* offline: try again next time */ }
  });
}
