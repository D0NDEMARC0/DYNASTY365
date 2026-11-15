// Live box scores while NFL and college games are being played.
// Source: Sleeper's stats feed (Sportradar data). Sleeper's API is free for non-commercial use, allows requests from
// any website and its CDN refreshes the feed every few seconds, so the browser reads it directly: it works the same
// on the website and on your computer, and nothing is stored.

const API = 'https://api.sleeper.com';
const APP = 'https://api.sleeper.app/v1';
export const SKILL = ['QB', 'RB', 'WR', 'TE'];
// NFL team defenses carry the points each team allowed, which gives the score; college has no such row. Kickers and
// defenses are shown only for a league that starts them.
export const SPORTS = {
  nfl: { label: 'NFL', positions: [...SKILL, 'K', 'DEF'], every: 30e3 },
  cfb: { label: 'College', positions: SKILL, every: 60e3 },
};
const KEEP = new Set([...SKILL, 'FB', 'K', 'DEF']);
// bookkeeping fields: a row with nothing else is a player who is active but hasn't recorded a stat
const META = /^(gms_active|gp|gs|pos_rank_|pts_(std|ppr|half_ppr|idp)$|off_snp|def_snp|st_snp|tm_|penalty)/;
const played = s => Object.keys(s).some(k => !META.test(k));

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
 * rows:  [{ id (Sleeper player id; a team abbreviation for a defense), name, pos, team, opp, gameId, stats, played }]
 * — skill players, kickers and team defenses Sleeper lists this week; played is false for an active player with no
 * stat yet. A game with a stat has kicked off even while the schedule (which Sleeper refreshes every 10 minutes)
 * still says it hasn't.
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
    const pos = r.player?.position, s = r.stats || {}, did = played(s);
    let g = games.get(r.game_id);
    if (!g && r.game_id && did) {
      // not on the schedule: name the teams from the row, without knowing which one is at home
      g = { id: r.game_id, home: r.opponent, away: r.team, date: r.date, status: 'in_game', started: true, vs: true };
      games.set(r.game_id, g);
    }
    if (g && did) g.started = true;
    if (pos === 'DEF') def.set(r.team, s);
    if (!KEEP.has(pos)) continue;
    rows.push({
      id: String(r.player_id), name: [r.player?.first_name, r.player?.last_name].filter(Boolean).join(' '), pos,
      team: r.team, opp: r.opponent, gameId: r.game_id, stats: s, played: did,
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
export const stTd = s => s.st_td ?? ((s.kr_td || 0) + (s.pr_td || 0));
// team-defense stats score only for a team defense (a college two-way player's tackles or interceptions don't count)
const TEAM_DEF = /^(def_|pts_allow|yds_allow|sack|int$|int_|ff$|fum_rec$|fum_ret|safe$|blk_kick|qb_hit|tkl)/;

/**
 * Fantasy points from a Sleeper stat line, with the stats that earned them. Sleeper's league scoring uses the same
 * keys as its stats (bonuses included, e.g. bonus_rec_te counts a tight end's catches), so league points are a plain
 * sum; the app's PPR / half / standard presets reproduce Sleeper's own pts_ppr exactly. Return touchdowns count 6
 * unless the scoring says otherwise.
 * Returns { pts, items: [{ k (stat), v (count), m (points each), pts }] }.
 */
const CATCH_BONUS = { bonus_rec_te: 'TE', bonus_rec_rb: 'RB', bonus_rec_wr: 'WR' };
export function scorePlayer(stats, scoring, pos) {
  const items = [], player = pos !== 'DEF' && pos !== 'K';
  for (const k in scoring) {
    const v = stats[k] ?? (CATCH_BONUS[k] === pos ? stats.rec : undefined), m = scoring[k];
    if (v && m && !(player && TEAM_DEF.test(k))) items.push({ k, v, m, pts: v * m });
  }
  if (player && scoring.st_td == null && stTd(stats)) items.push({ k: 'st_td', v: stTd(stats), m: 6, pts: stTd(stats) * 6 });
  const pts = items.reduce((t, x) => t + x.pts, 0);
  return { pts: Math.round(pts * 100) / 100, items };
}
export const livePoints = (stats, scoring, pos) => scorePlayer(stats, scoring, pos).pts;

// what each scoring stat is called in a points breakdown, in box-score order
const NAMES = [
  ['Passing', {
    pass_yd: 'Passing yards', pass_td: 'Passing TDs', pass_int: 'Interceptions', pass_int_td: 'Pick-sixes thrown', pass_2pt: '2-pt passes',
    pass_cmp: 'Completions', pass_inc: 'Incompletions', pass_att: 'Pass attempts', pass_sack: 'Sacks taken', pass_fd: 'Passing first downs',
    pass_cmp_40p: '40+ yd completions', pass_td_40p: '40+ yd TD passes', pass_td_50p: '50+ yd TD passes',
    bonus_pass_yd_300: '300-yd passing bonus', bonus_pass_yd_400: '400-yd passing bonus', bonus_pass_cmp_25: '25-completion bonus', bonus_fd_qb: 'QB first-down bonus',
  }],
  ['Rushing', {
    rush_yd: 'Rushing yards', rush_td: 'Rushing TDs', rush_att: 'Carries', rush_2pt: '2-pt runs', rush_fd: 'Rushing first downs',
    rush_40p: '40+ yd runs', rush_td_40p: '40+ yd TD runs', rush_td_50p: '50+ yd TD runs',
    bonus_rush_yd_100: '100-yd rushing bonus', bonus_rush_yd_200: '200-yd rushing bonus', bonus_rush_att_20: '20-carry bonus',
  }],
  ['Receiving', {
    rec: 'Receptions', rec_yd: 'Receiving yards', rec_td: 'Receiving TDs', rec_2pt: '2-pt catches', rec_tgt: 'Targets', rec_fd: 'Receiving first downs',
    rec_40p: '40+ yd catches', rec_td_40p: '40+ yd TD catches', rec_td_50p: '50+ yd TD catches',
    rec_0_4: 'Catches of 0-4 yds', rec_5_9: 'Catches of 5-9 yds', rec_10_19: 'Catches of 10-19 yds', rec_20_29: 'Catches of 20-29 yds', rec_30_39: 'Catches of 30-39 yds',
    bonus_rec_te: 'TE catch bonus', bonus_rec_rb: 'RB catch bonus', bonus_rec_wr: 'WR catch bonus',
    bonus_rec_yd_100: '100-yd receiving bonus', bonus_rec_yd_200: '200-yd receiving bonus',
  }],
  ['Other', {
    fum_lost: 'Fumbles lost', fum: 'Fumbles', fum_rec_td: 'Fumble recovery TDs', st_td: 'Return TDs', st_ff: 'Special-teams forced fumbles',
    st_fum_rec: 'Special-teams fumble recoveries', st_tkl_solo: 'Special-teams tackles', kr_yd: 'Kick return yards', pr_yd: 'Punt return yards',
    bonus_rush_rec_yd_100: '100-yd scrimmage bonus', bonus_rush_rec_yd_200: '200-yd scrimmage bonus',
    bonus_fd_rb: 'RB first-down bonus', bonus_fd_wr: 'WR first-down bonus', bonus_fd_te: 'TE first-down bonus', first_td: 'First TD of the game',
  }],
  ['Kicking', {
    fgm: 'Field goals', fgm_0_19: 'FGs of 0-19 yds', fgm_20_29: 'FGs of 20-29 yds', fgm_30_39: 'FGs of 30-39 yds', fgm_40_49: 'FGs of 40-49 yds',
    fgm_50p: 'FGs of 50+ yds', fgm_50_59: 'FGs of 50-59 yds', fgm_60p: 'FGs of 60+ yds', fgm_yds: 'Field goal yards', fgm_yds_over_30: 'FG yards over 30',
    fgmiss: 'Missed FGs', fgmiss_0_19: 'Missed FGs of 0-19 yds', fgmiss_20_29: 'Missed FGs of 20-29 yds', fgmiss_30_39: 'Missed FGs of 30-39 yds',
    fgmiss_40_49: 'Missed FGs of 40-49 yds', fgmiss_50p: 'Missed FGs of 50+ yds', xpm: 'Extra points', xpmiss: 'Missed extra points',
  }],
  ['Defense', {
    def_td: 'Defensive TDs', def_st_td: 'Return TDs', sack: 'Sacks', int: 'Interceptions', fum_rec: 'Fumble recoveries', ff: 'Forced fumbles',
    safe: 'Safeties', blk_kick: 'Blocked kicks', def_2pt: '2-pt returns', def_st_ff: 'Special-teams forced fumbles', def_st_fum_rec: 'Special-teams fumble recoveries',
    pts_allow_0: 'Shutout', pts_allow_1_6: '1-6 points allowed', pts_allow_7_13: '7-13 points allowed', pts_allow_14_20: '14-20 points allowed',
    pts_allow_21_27: '21-27 points allowed', pts_allow_28_34: '28-34 points allowed', pts_allow_35p: '35+ points allowed', pts_allow: 'Points allowed',
    yds_allow_0_100: 'Under 100 yards allowed', yds_allow_100_199: '100-199 yards allowed', yds_allow_200_299: '200-299 yards allowed',
    yds_allow_300_349: '300-349 yards allowed', yds_allow_350_399: '350-399 yards allowed', yds_allow_400_449: '400-449 yards allowed',
    yds_allow_450_499: '450-499 yards allowed', yds_allow_500_549: '500-549 yards allowed', yds_allow_550p: '550+ yards allowed', yds_allow: 'Yards allowed',
    tkl_loss: 'Tackles for loss', qb_hit: 'QB hits', def_pass_def: 'Passes defended', def_3_and_out: 'Three-and-outs', def_4_and_stop: 'Fourth-down stops',
    def_forced_punts: 'Forced punts', sack_yd: 'Sack yards', int_ret_yd: 'Interception return yards', fum_ret_yd: 'Fumble return yards',
  }],
];
const NAME = {}, RANK = {};
NAMES.forEach(([g, m], gi) => Object.entries(m).forEach(([k, l], i) => { NAME[k] = l; RANK[k] = gi * 100 + i; }));
const groupRank = k => (/^(pass|bonus_pass)/.test(k) ? 0 : /^(rush|bonus_rush)/.test(k) ? 1 : /^(rec|bonus_rec)/.test(k) ? 2 : /^(fg|xp)/.test(k) ? 4 : TEAM_DEF.test(k) ? 5 : 3);
/** A scoring stat's name: "Passing TDs" (unlisted Sleeper keys are spelled out: "bonus pass cmp 30"). */
export const statName = k => NAME[k] || k.replace(/_/g, ' ');
/** Points items in box-score order: passing, rushing, receiving, other, kicking, defense. */
export const orderItems = items => [...items].sort((a, b) => (RANK[a.k] ?? groupRank(a.k) * 100 + 99) - (RANK[b.k] ?? groupRank(b.k) * 100 + 99));
/** A yes/no stat (a 100-yard bonus, a points-allowed bracket) reads better without "1 ×". */
export const isFlag = (k, v) => v === 1 && /^(bonus_(pass|rush|rec|rush_rec)_yd_|bonus_pass_cmp_|bonus_rush_att_|pts_allow_|yds_allow_|first_td)/.test(k);

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
