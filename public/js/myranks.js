// Your own rankings: an order you set for NFL players (per QB format) and for each prospect class. Saved in this
// browser, and in your account when you're signed in (see cloud.js).
export const KEY = 'dl.myranks.v1';
const mem = { v: null }; // fallback when the browser blocks storage

function read() {
  if (mem.v) return mem.v;
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}
function write(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); mem.v = null; } catch { mem.v = all; }
  window.dispatchEvent(new Event('dl:changed'));
}

/** Your NFL order for a QB format ('1' or '2'): player ids best first, or null if you haven't made one. */
export const nflOrder = qb => read().nfl?.[qb]?.ids || null;
export function setNflOrder(qb, ids) {
  const all = read();
  (all.nfl ||= {})[qb] = { ids, updated: new Date().toISOString() };
  write(all);
}
export function clearNflOrder(qb) { const all = read(); if (all.nfl) delete all.nfl[qb]; write(all); }

/**
 * Your board for a prospect class: { keys (best first), tep (whether TE premium was on when you last edited) }, or
 * null if you haven't made one.
 */
export const classBoard = cls => read().college?.[cls] || null;
export function setClassBoard(cls, keys, tep) {
  const all = read();
  (all.college ||= {})[cls] = { keys, tep: !!tep, updated: new Date().toISOString() };
  write(all);
}
export function clearClassBoard(cls) { const all = read(); if (all.college) delete all.college[cls]; write(all); }

/**
 * A saved order brought up to date with the current list: keys that no longer exist are dropped, new ones join the
 * end in the given default order. Returns null when there's no saved order.
 */
export function complete(saved, defaultOrder) {
  if (!saved) return null;
  const have = new Set(defaultOrder), seen = new Set();
  const out = saved.filter(k => have.has(k) && !seen.has(k) && seen.add(k));
  for (const k of defaultOrder) if (!seen.has(k)) out.push(k);
  return out;
}

/** Move key to just before (or after) target in an order; returns a new array. */
export function moveKey(order, key, target, after = false) {
  if (key === target) return order;
  const out = order.filter(k => k !== key);
  const i = out.indexOf(target);
  if (i < 0) return order;
  out.splice(after ? i + 1 : i, 0, key);
  return out;
}
/** Move key to overall rank r (1-based). */
export function moveTo(order, key, r) {
  const out = order.filter(k => k !== key);
  out.splice(Math.max(0, Math.min(out.length, Math.round(r) - 1)), 0, key);
  return out;
}
