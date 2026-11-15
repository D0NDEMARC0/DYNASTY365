// Live box scores while NFL and college games are being played.
// Source: Sleeper's stats feed (Sportradar data). Sleeper's API is free for non-commercial use, allows requests from
// any website and its CDN refreshes the feed every few seconds, so the browser reads it directly: it works the same
// on the website and on your computer, and nothing is stored.

const API = 'https://api.sleeper.com';
const APP = 'https://api.sleeper.app/v1';
export const SKILL = ['QB', 'RB', 'WR', 'TE'];
// NFL team defenses carry the points each team allowed, which gives the score; college has no such row
export const SPORTS = {
  nfl: { label: 'NFL', positions: [...SKILL, 'DEF'], every: 30e3 },
  cfb: { label: 'College', positions: SKILL, every: 60e3 },
};

async function get(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`Sleeper returned ${r.status}`);
  return r.json();
}
const memo = new Map();
function cached(key, ms, fn) {
  const m = memo.get(key);
  if (m && Date.now() - m.t < ms) return m.p;
  const p = fn();
  memo.set(key, { t: Date.now(), p });
  p.catch(() => memo.delete(key));
  return p;
}

/** The sport's current week: { season, week, type } (type 'regular' or 'post'); week is null between seasons. */
export function liveWeek(sport) {
  return cached(`state:${sport}`, 10 * 60e3, async () => {
    const s = await get(`${APP}/state/${sport}`);
    const inSeason = s.season_type === 'regular' || s.season_type === 'post';
    return { season: Number(s.season), week: inSeason ? Number(s.week) : null, type: s.season_type === 'post' ? 'post' : 'regular' };
  });
}

const schedule = (sport, season, type) => cached(`sched:${sport}:${season}:${type}`, 2 * 60e3, () => get(`${API}/schedule/${sport}/${type}/${season}`));

/** Points a team scored: what the other defense allowed, plus its own defensive and return touchdowns and safeties. */
const teamScore = (own, opp) => (opp?.pts_allow || 0) + 6 * (own?.def_td || 0) + 2 * (own?.safe || 0);

/**
 * One week of games and box scores.
 * games: [{ id, home, away, date, state: 'pre' | 'live' | 'final', hs, as (NFL scores once started) }]
 * rows:  [{ id (Sleeper player id), name, pos, team, opp, gameId, stats }] — skill players with a stat this week.
 * Sleeper lists a player once he records a stat, so a game with rows has kicked off even while the schedule
 * (which Sleeper refreshes every 10 minutes) still says it hasn't.
 */
export async function loadWeek(sport, { season, week, type }, { fresh = true } = {}) {
  const qs = SPORTS[sport].positions.map(p => `position%5B%5D=${p}`).join('&');
  const statsUrl = `${API}/stats/${sport}/${season}/${week}?season_type=${type}&${qs}`;
  const [sched, stats] = await Promise.all([
    schedule(sport, season, type).catch(() => []),
    fresh ? get(statsUrl) : cached(`week:${statsUrl}`, 60e3, () => get(statsUrl)),
  ]);
  const games = new Map();
  for (const g of sched) if (g.week === week) games.set(g.game_id, { id: g.game_id, home: g.home, away: g.away, date: g.date, status: g.status, started: false });
  const def = new Map(), rows = [];
  for (const r of stats || []) {
    const pos = r.player?.position;
    let g = games.get(r.game_id);
    if (!g && r.game_id) {
      // not on the schedule: name the teams from the row, without knowing which one is at home
      g = { id: r.game_id, home: r.opponent, away: r.team, date: r.date, status: 'in_game', started: true, vs: true };
      games.set(r.game_id, g);
    }
    if (g) g.started = true;
    if (pos === 'DEF') { def.set(r.team, r.stats || {}); continue; }
    if (!SKILL.includes(pos)) continue;
    rows.push({
      id: String(r.player_id), name: [r.player?.first_name, r.player?.last_name].filter(Boolean).join(' '), pos,
      team: r.team, opp: r.opponent, gameId: r.game_id, stats: r.stats || {},
    });
  }
  for (const g of games.values()) {
    g.state = g.status === 'complete' ? 'final' : g.started || g.status === 'in_game' ? 'live' : 'pre';
    if (sport === 'nfl' && g.state !== 'pre') { g.hs = teamScore(def.get(g.home), def.get(g.away)); g.as = teamScore(def.get(g.away), def.get(g.home)); }
  }
  const list = [...games.values()];
  return { sport, season, week, type, games: list, rows, live: list.some(g => g.state === 'live'), fetched: Date.now() };
}

/** Is any NFL or college game being played right now? (for the dot on the Live tab) */
export async function anyLive() {
  const one = async sport => {
    const w = await liveWeek(sport);
    if (!w.week) return false;
    const today = new Date();
    return (await schedule(sport, w.season, w.type)).some(g => g.week === w.week && g.status === 'in_game'
      && Math.abs(new Date(`${g.date}T12:00:00`) - today) < 2 * 864e5);
  };
  const r = await Promise.allSettled([one('nfl'), one('cfb')]);
  return r.some(x => x.value === true);
}

/** One NFL player's line this week (Sleeper id), or null before his first stat. */
export async function nflPlayerWeek(sid) {
  const w = await liveWeek('nfl');
  if (!w.week) return null;
  const [byWeek, sched] = await Promise.all([
    get(`${API}/stats/nfl/player/${encodeURIComponent(sid)}?season_type=${w.type}&season=${w.season}&grouping=week`).catch(() => null),
    schedule('nfl', w.season, w.type).catch(() => []),
  ]);
  return { ...w, row: byWeek?.[w.week] || null, games: sched.filter(g => g.week === w.week) };
}

// ---------- fantasy points ----------
const stTd = s => s.st_td ?? ((s.kr_td || 0) + (s.pr_td || 0));
/**
 * Fantasy points from a Sleeper stat line. Sleeper's league scoring uses the same keys as its stats (bonuses
 * included, e.g. bonus_rec_te counts a tight end's catches), so league points are a plain sum; the app's PPR / half /
 * standard presets reproduce Sleeper's own pts_ppr exactly. Return touchdowns count 6 unless the scoring says otherwise.
 */
export function livePoints(stats, scoring) {
  let pts = 0;
  for (const k in scoring) { const v = stats[k]; if (v) pts += v * scoring[k]; }
  if (scoring.st_td == null) pts += stTd(stats) * 6;
  return Math.round(pts * 100) / 100;
}

/** A box-score line: "17/25, 212 yds, 2 TD · 4 car, 18 yds" (receivers lead with receiving). */
export function statLine(s, pos) {
  const n = k => s[k] || 0;
  const td = k => (n(k) ? `, ${n(k)} TD` : '');
  const pass = n('pass_att') ? `${n('pass_cmp')}/${n('pass_att')}, ${n('pass_yd')} yds${td('pass_td')}${n('pass_int') ? `, ${n('pass_int')} INT` : ''}` : '';
  const rush = n('rush_att') ? `${n('rush_att')} car, ${n('rush_yd')} yds${td('rush_td')}` : '';
  const recv = n('rec_tgt') || n('rec') ? `${n('rec')} rec, ${n('rec_yd')} yds${td('rec_td')}${n('rec_tgt') ? ` (${n('rec_tgt')} tgt)` : ''}` : '';
  const parts = pos === 'WR' || pos === 'TE' ? [recv, rush, pass] : [pass, rush, recv];
  if (stTd(s)) parts.push(`${stTd(s)} return TD`);
  if (n('fum_lost')) parts.push(`${n('fum_lost')} fumble${n('fum_lost') > 1 ? 's' : ''} lost`);
  return parts.filter(Boolean).join(' · ');
}

// ---------- college: Sleeper's player ids -> this app's (ESPN) ids ----------
const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
export const nameKey = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’.]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && !SUFFIX.has(w)).join(' ');

/**
 * Match Sleeper's college rows to this app's players by name and school. Sleeper names schools by abbreviation
 * (OSU, MIZZ, M-OH), so the abbreviation -> school table is learned from players whose name is unique. A name shared
 * by several players needs the school; a nickname ("Cam" for Cameron) matches on last name, school and position.
 * pool: [{ cid, name, team, pos }]. Returns { ids: Map(sleeper id -> cid), school: Map(abbreviation -> school) }.
 */
export function matchCollege(rows, pool) {
  const byName = new Map(), byLast = new Map();
  const add = (m, k, p) => { const a = m.get(k) || []; if (!a.some(x => x.cid === p.cid)) a.push(p); m.set(k, a); };
  for (const p of pool) {
    const k = nameKey(p.name);
    if (!k || !p.cid) continue;
    add(byName, k, p);
    add(byLast, `${p.team}|${k.split(' ').pop()}|${p.pos}`, p);
  }
  const votes = new Map();
  for (const r of rows) {
    const c = byName.get(nameKey(r.name));
    if (c?.length !== 1 || !c[0].team) continue;
    const v = votes.get(r.team) || new Map();
    v.set(c[0].team, (v.get(c[0].team) || 0) + 1);
    votes.set(r.team, v);
  }
  const school = new Map();
  for (const [abbr, v] of votes) {
    const [[best, n], second] = [...v].sort((a, b) => b[1] - a[1]);
    if ((n >= 2 && (!second || n >= 2 * second[1])) || (n === 1 && v.size === 1)) school.set(abbr, best);
  }
  const ids = new Map(), used = new Set(), later = [];
  for (const r of rows) {
    const k = nameKey(r.name), sch = school.get(r.team);
    const c = byName.get(k) || [];
    let m = null;
    if (sch) {
      const t = c.filter(x => x.team === sch);
      if (t.length === 1) m = t[0];
      else if (!t.length) later.push([r, k, sch]);
    } else if (c.length === 1) m = c[0];
    if (m) { ids.set(r.id, m.cid); used.add(m.cid); }
  }
  // nicknames: same school, position and last name, and one first name starts the other (Cam / Cameron)
  for (const [r, k, sch] of later) {
    const w = k.split(' ');
    const l = (byLast.get(`${sch}|${w[w.length - 1]}|${r.pos}`) || []).filter(p => {
      const f = nameKey(p.name).split(' ')[0];
      return !used.has(p.cid) && (f.startsWith(w[0]) || w[0].startsWith(f));
    });
    if (l.length === 1) { ids.set(r.id, l[0].cid); used.add(l[0].cid); }
  }
  return { ids, school };
}
