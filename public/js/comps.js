// Pro comps: the former and current NFL players whose college season looked most like a given season, at the same
// stage of college (years out of high school), and what they went on to do in the NFL.
// Shared by the data pipeline (Node: the board's "Pro comp" column) and the app (college player pages), so both always
// agree. Keep it free of DOM and Node APIs.

const TIER_N = { P4: 1, P5: 1, G6: 0, G5: 0, FCS: -1 };

// College volume per team game: enough to list a season (SHOW) and to qualify for percentiles (QUAL). The data build
// uses these too.
export const VOL = { WR: s => s.tgt || 0, TE: s => s.tgt || 0, RB: s => (s.car || 0) + (s.tgt || 0), QB: s => s.pa || 0 };
export const SHOW = { WR: 2, TE: 1.5, RB: 4, QB: 8 };
export const QUAL = { WR: 3.5, TE: 2.5, RB: 7, QB: 15 };
/** Enough volume to compare a season (teamGames: that season's typical number of team games so far). */
export const hasVolume = (s, teamGames) => !!VOL[s.pos] && VOL[s.pos](s) >= SHOW[s.pos] * (teamGames || 12);

/** A college season row plus the per-game and per-attempt rates the comps use. */
export function derive(s) {
  const g = s.g || 0;
  const per = v => (g > 0 && v != null ? v / g : null);
  return {
    ...s,
    recpg: per(s.rec), reypg: per(s.reyd), retdpg: per(s.retd), tdpg: per((s.rutd || 0) + (s.retd || 0)),
    pypg: per(s.pyd), ptdr: s.pa > 0 ? s.ptd / s.pa : null, intr: s.pa > 0 ? s.int / s.pa : null, rutdpg: per(s.rutd),
    tierN: TIER_N[s.tier] ?? null,
  };
}

// What makes two seasons alike, per position: [stat, weight]. Role and production carry the most weight, then
// efficiency and style, then size and level of competition. Weights sum to 1.
export const COMP_FEATURES = {
  WR: [['dom', 0.14], ['yptpa', 0.12], ['tsh', 0.1], ['reypg', 0.12], ['yprr', 0.06], ['retdpg', 0.06], ['ypr', 0.07], ['catch', 0.04],
    ['epat', 0.06], ['adot', 0.05], ['yacr', 0.03], ['rec20r', 0.04], ['wt', 0.05], ['ht', 0.03], ['tierN', 0.03]],
  TE: [['dom', 0.14], ['yptpa', 0.12], ['tsh', 0.1], ['reypg', 0.12], ['yprr', 0.06], ['retdpg', 0.06], ['ypr', 0.06], ['catch', 0.04],
    ['epat', 0.06], ['adot', 0.04], ['yacr', 0.03], ['rec20r', 0.04], ['wt', 0.06], ['ht', 0.04], ['tierN', 0.03]],
  RB: [['scsh', 0.13], ['csh', 0.08], ['scpg', 0.12], ['ypc', 0.09], ['tsh', 0.08], ['recpg', 0.06], ['tdpg', 0.07], ['epar', 0.06],
    ['rusr', 0.04], ['exp10', 0.07], ['brk', 0.05], ['stuff', 0.04], ['wt', 0.07], ['ht', 0.02], ['tierN', 0.02]],
  QB: [['epap', 0.15], ['ypa', 0.1], ['cpoe', 0.09], ['pypg', 0.1], ['ptdr', 0.08], ['intr', 0.06], ['psr', 0.06], ['skr', 0.04],
    ['padot', 0.04], ['rypg', 0.12], ['qypc', 0.05], ['rutdpg', 0.04], ['wt', 0.02], ['ht', 0.03], ['tierN', 0.02]],
};
/** Season row fields the comps need: every input of derive() and COMP_FEATURES, plus the stat line shown side by side. */
export const COMP_FIELDS = {
  WR: ['team', 'tier', 'cls', 'q', 'g', 'tgt', 'rec', 'reyd', 'retd', 'tsh', 'dom', 'yprr', 'yptpa', 'epat', 'rec20r', 'ypr', 'catch', 'adot', 'yacr', 'ht', 'wt'],
  RB: ['team', 'tier', 'cls', 'q', 'g', 'car', 'ruyd', 'rutd', 'ypc', 'exp10', 'stuff', 'brk', 'tgt', 'rec', 'reyd', 'retd', 'scsh', 'csh', 'rdom', 'tsh',
    'epar', 'rusr', 'scpg', 'yprr', 'ht', 'wt'],
  QB: ['team', 'tier', 'cls', 'q', 'g', 'pa', 'pc', 'pyd', 'ptd', 'int', 'ypa', 'epap', 'cpoe', 'psr', 'skr', 'padot', 'qcar', 'qruyd', 'qypc', 'rutd',
    'rypg', 'ht', 'wt'],
};
COMP_FIELDS.TE = COMP_FIELDS.WR;
// stats compared against that season's players (tierN is already on a fixed scale)
const normKeys = pos => COMP_FEATURES[pos].map(f => f[0]).filter(k => k !== 'tierN');
const CLIP = 3.5; // one freak stat can't decide a comp on its own
const MIN_SHARED = 0.6; // seasons must share stats covering 60% of the weight
export const YEAR_WEIGHT = 0.12; // "any year": penalty per year of college apart

const r4 = x => Math.round(x * 1e4) / 1e4;
/**
 * Mean and SD of each comp stat among qualified FBS players at the position in one season. Comparing each season
 * with its own year keeps eras fair (college passing in 2006 isn't college passing in 2025).
 */
export function seasonNorms(rows, pos) {
  const pool = rows.filter(s => s.pos === pos && s.q && s.div === 'fbs').map(derive);
  const out = {};
  for (const k of normKeys(pos)) {
    const v = pool.map(s => s[k]).filter(x => x != null && Number.isFinite(x));
    if (v.length < 20) continue;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
    if (sd > 0) out[k] = [r4(m), r4(sd)];
  }
  return out;
}

/** Standardized stats for one season (null where a stat is missing or wasn't measured that year). */
export function zVector(s, pos, norms) {
  const d = derive(s), n = norms?.[s.season] || {};
  return COMP_FEATURES[pos].map(([k]) => {
    const x = d[k];
    if (x == null || !Number.isFinite(x)) return null;
    if (k === 'tierN') return x;
    const m = n[k];
    return m ? Math.max(-CLIP, Math.min(CLIP, (x - m[0]) / m[1])) : null;
  });
}

/** Weighted mean squared gap between two standardized seasons, over the stats both have (null if too few). */
export function distance2(a, b, pos, yrGap = 0) {
  const F = COMP_FEATURES[pos];
  let s = 0, w = 0;
  for (let i = 0; i < F.length; i++) {
    if (a[i] == null || b[i] == null) continue;
    s += F[i][1] * (a[i] - b[i]) ** 2; w += F[i][1];
  }
  if (w < MIN_SHARED) return null;
  if (yrGap) { s += YEAR_WEIGHT * yrGap * yrGap; w += YEAR_WEIGHT; }
  return s / w;
}
/** 0–100. Two typical qualified players score ~35; a close comp 85+. */
export const similarity = d2 => Math.round(100 * Math.exp(-d2 / 2));

// years out of high school, with 5th and 6th years grouped (super seniors, COVID years)
export const stage = yr => (yr == null ? null : Math.max(1, Math.min(5, yr)));

/**
 * The closest pro seasons to `target` ({ cid, yr, z }). pool: [{ cid, yr, z, ... }] (one row per pro season).
 * mode 'same' = same year out of high school only; 'any' = any year, with a penalty per year apart.
 * Each pro appears once (his closest season); the target player himself is skipped.
 */
export function findComps(target, pool, pos, { mode = 'same', n = 10 } = {}) {
  const ty = stage(target.yr);
  if (mode === 'same' && ty == null) return [];
  const best = new Map();
  for (const r of pool) {
    if (r.cid === target.cid) continue;
    const ry = stage(r.yr);
    if (mode === 'same' && ry !== ty) continue;
    const d2 = distance2(target.z, r.z, pos, mode === 'any' && ty != null && ry != null ? ty - ry : 0);
    if (d2 == null) continue;
    const cur = best.get(r.cid);
    if (!cur || d2 < cur.d2) best.set(r.cid, { r, d2 });
  }
  return [...best.values()].sort((a, b) => a.d2 - b.d2).slice(0, n).map(({ r, d2 }) => ({ ...r, d2, sim: similarity(d2) }));
}

/** Per stat: how far apart two standardized seasons are (in SDs), for the side-by-side view. */
export const gaps = (a, b, pos) => COMP_FEATURES[pos].map(([k, w], i) => ({ k, w, gap: a[i] == null || b[i] == null ? null : Math.abs(a[i] - b[i]) }));

/** An NFL career in a few words: the bar a comp cleared (top-12 / top-24 PPR seasons). */
export const hitBar = pos => (pos === 'QB' || pos === 'TE' ? 12 : 24);
