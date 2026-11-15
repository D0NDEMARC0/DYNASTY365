// Pro comps data. For everyone who reached the NFL: his college seasons since 2004 (ESPN via sportsdataverse) and his
// NFL results (nflverse), plus every college season's norms, written per position (data/out/comps_WR.json, …) for the
// college player page; and each prospect's closest comp for the board. The matching itself is public/js/comps.js,
// shared with the app.
// College seasons before the app's live window come from a committed seed (comps_history.json.gz, made once by
// pipeline/comps-seed.mjs): those seasons never change, so regular builds never download 15 years of play-by-play.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { nflverse } from './fetch.mjs';
import { readParquet } from './load.mjs';
import { nameKey } from './imports.mjs';
import { COMP_FIELDS, COMP_FEATURES, seasonNorms, zVector, findComps } from '../public/js/comps.js';

export const SEED = fileURLToPath(new URL('./comps_history.json.gz', import.meta.url));
export const SKILL = ['QB', 'RB', 'WR', 'TE'];
// a seed row: these, then that position's COMP_FIELDS
export const ROW_HEAD = ['season', 'pos', 'div', 'sh'];
const CLS = ['FR', 'SO', 'JR', 'SR'], CLASS_NUM = { FR: 1, SO: 2, JR: 3, SR: 4 };
const rd = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const NFL_FROM = 2005; // first NFL season for anyone with a 2004 college season

export const seedRow = s => [...ROW_HEAD, ...COMP_FIELDS[s.pos]].map(k => (typeof s[k] === 'number' ? rd(s[k], 4) : s[k] ?? null));
const fromSeedRow = a => {
  const f = [...ROW_HEAD, ...COMP_FIELDS[a[1]]];
  return Object.fromEntries(f.map((k, i) => [k, a[i]]));
};
export function readSeed() {
  if (!fs.existsSync(SEED)) return null;
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(SEED)).toString('utf8'));
}
export const writeSeed = obj => fs.writeFileSync(SEED, zlib.gzipSync(JSON.stringify(obj), { level: 9 }));
/**
 * [class number, roster year it belongs to] from a seed player's final season (raw ESPN class), or null. His last
 * roster year counts up to one year past his last season with stats (an opt-out or injury year); later listings are
 * stale roster data.
 */
function seedClass(seed, cid) {
  const p = seed?.players?.[cid];
  if (!p?.r?.length) return null;
  const last = fromSeedRow(p.r[p.r.length - 1]);
  const n = CLASS_NUM[last.cls];
  return n ? [n, Math.max(last.season, Math.min(seed.lr?.[cid] ?? last.season, last.season + 1))] : null;
}

/** NFL regular seasons per player (gsis id): games, PPR points, and finish at his position by total points. */
export async function nflSeasons(current, log) {
  const by = new Map();
  for (let y = NFL_FROM; y <= current; y++) {
    const f = await nflverse('stats_player', `stats_player_reg_${y}.parquet`, y >= current ? 12 : 24 * 30);
    if (!f) continue;
    const byPos = {};
    for (const r of await readParquet(f, ['player_id', 'position', 'games', 'fantasy_points_ppr'])) {
      const pos = r.position === 'FB' ? 'RB' : r.position;
      if (r.player_id && SKILL.includes(pos)) (byPos[pos] ||= []).push(r);
    }
    for (const [pos, list] of Object.entries(byPos)) {
      list.sort((a, b) => (b.fantasy_points_ppr || 0) - (a.fantasy_points_ppr || 0)).forEach((r, i) => {
        if (!by.has(r.player_id)) by.set(r.player_id, []);
        by.get(r.player_id).push({ y, pos, g: r.games || 0, pts: r.fantasy_points_ppr || 0, rank: i + 1 });
      });
    }
  }
  log(`  NFL results ${NFL_FROM}–${current}: ${by.size} players`);
  return by;
}
/** Reached the NFL: drafted, or played at least one regular-season game. */
export const isPro = (np, seasons) => !!(np?.draft_year || seasons?.some(x => x.g > 0));
export const NFL_SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'FB']);

// nflverse school names vs ESPN's, where they differ (found by matching drafted players to college rosters)
const SCHOOL_ALIAS = { mississippi: 'olemiss', floridainternational: 'floridaintl', fiu: 'floridaintl', umassamherst: 'massachusetts', umass: 'massachusetts',
  texaselpaso: 'utep', louisianast: 'lsu', southerncalifornia: 'usc', centralflorida: 'ucf', brighamyoung: 'byu', texaschristian: 'tcu',
  southernmethodist: 'smu', nevadalasvegas: 'unlv', alabamabirmingham: 'uab', texassanantonio: 'utsa' };
const schoolNorm = s => {
  const k = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\bstate\b/g, 'st')
    .replace(/\buniversity\b|\bof\b|\bthe\b/g, '').replace(/[^a-z]/g, '');
  return SCHOOL_ALIAS[k] || k;
};
const sameSchool = (a, b) => {
  const x = schoolNorm(a), y = schoolNorm(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))));
};
/**
 * College player -> NFL player. ESPN keeps the college athlete id in the NFL for players drafted from about 2017 on;
 * before that the ids differ, so: same name, a shared school, and an NFL arrival (draft or first season) 1–3 years
 * after his last college season, with exactly one NFL player fitting. An NFL player already linked by id is never
 * given to a namesake.
 * careers: Map(cid -> { name, teams: string[], last }); nfl: nflverse player rows.
 */
export function linkPros(careers, nfl) {
  const byEspn = new Map(), byName = new Map();
  for (const np of nfl) {
    if (!np.gsis_id) continue;
    if (np.espn_id != null) byEspn.set(String(np.espn_id), np);
    const k = nameKey(np.display_name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(np);
  }
  const out = new Map();
  for (const [cid, c] of careers) {
    let np = byEspn.get(cid);
    if (!np) {
      const cands = (byName.get(nameKey(c.name)) || []).filter(n => {
        if (n.espn_id != null && careers.has(String(n.espn_id))) return false;
        const y = n.draft_year ?? n.rookie_season;
        if (y == null || y < c.last + 1 || y > c.last + 3) return false;
        const cols = String(n.college_name || '').split(';');
        return c.teams.some(t => cols.some(col => sameSchool(col, t)));
      });
      if (cands.length === 1) np = cands[0];
    }
    if (np) out.set(cid, np);
  }
  return out;
}
/** For linking: a career's name (latest), schools and last college season. */
export const careerKey = rows => ({ name: rows[rows.length - 1].name, teams: [...new Set(rows.map(s => s.team).filter(Boolean))], last: rows[rows.length - 1].season });

// what each pro record holds (comps_*.json "pros"), in order
export const PRO_FIELDS = ['name', 'nflPos', 'draftYear', 'round', 'pick', 'id', 'g', 'ppg', 'bestYear', 'bestRank', 'bestPpg', 'top12', 'top24', 'first', 'last'];
function nflSummary(list) {
  const played = (list || []).filter(x => x.g > 0);
  if (!played.length) return Array(9).fill(null);
  const g = played.reduce((s, x) => s + x.g, 0), pts = played.reduce((s, x) => s + x.pts, 0);
  const best = [...played].sort((a, b) => a.rank - b.rank || b.pts / b.g - a.pts / a.g)[0];
  return [g, rd(pts / g), best.y, best.rank, rd(best.pts / best.g), played.filter(x => x.rank <= 12).length, played.filter(x => x.rank <= 24).length,
    played[0].y, played[played.length - 1].y];
}

/**
 * career: Map(cid -> live college seasons); bySeason: the live window's seasons ({ players, teamGames });
 * show(s): whether a season has enough volume to list; prospects get .pc (closest comp) in place.
 */
export async function buildComps({ current, career, eligByCid, bySeason, nflBy, gsis2sid, prospects, show, out, log }) {
  const seed = readSeed();
  const liveYears = Object.keys(bySeason).map(Number);
  const liveFrom = Math.min(...liveYears);
  if (!seed) log('  pro comps: no history seed (pipeline/comps_history.json.gz), so only college seasons from', liveFrom);
  else if (seed.to < liveFrom - 1) log(`  pro comps: the history seed ends in ${seed.to} but the live window starts in ${liveFrom}; re-run pipeline/comps-seed.mjs`);
  // each college season's norms, per position: the seed's for years before the live window, then the live ones
  const norms = Object.fromEntries(SKILL.map(p => [p, {}]));
  if (seed) for (const [y, byPos] of Object.entries(seed.norms)) if (Number(y) < liveFrom) for (const pos of SKILL) if (byPos[pos]) norms[pos][y] = byPos[pos];
  for (const y of liveYears) { const rows = [...bySeason[y].players.values()]; for (const pos of SKILL) norms[pos][y] = seasonNorms(rows, pos); }

  const nfl = await nflSeasons(current, log);
  const nflPros = [...nflBy.values()].filter(np => NFL_SKILL.has(np.position) && isPro(np, nfl.get(np.gsis_id)));
  // live-window college careers that have ended -> NFL players (the seed was linked when it was made)
  const ended = new Map();
  for (const [cid, list] of career) if (list[list.length - 1].season < current) ended.set(cid, careerKey(list));
  const liveLink = linkPros(ended, nflPros);

  // every college season of every pro, grouped by NFL player (a transfer can carry two ESPN college ids)
  const byG = new Map();
  const vol = s => (s.pa || 0) + (s.car || 0) + (s.tgt || 0);
  const add = (np, cid, s, live) => {
    let e = byG.get(np.gsis_id);
    if (!e) byG.set(np.gsis_id, (e = { np, cids: [], live: null, rows: new Map() }));
    if (!e.cids.includes(cid)) e.cids.push(cid);
    if (live) e.live = cid;
    const prev = e.rows.get(s.season);
    if (!prev || vol(s) > vol(prev)) e.rows.set(s.season, s);
  };
  if (seed) for (const [cid, p] of Object.entries(seed.players)) {
    const np = nflBy.get(p.g);
    if (np) for (const a of p.r) { const s = fromSeedRow(a); if (s.season < liveFrom) add(np, cid, s, false); }
  }
  for (const [cid, np] of liveLink) {
    for (const s of career.get(cid)) {
      if (!COMP_FIELDS[s.pos]) continue;
      const row = fromSeedRow(seedRow(s));
      row.sh = show(s);
      add(np, cid, row, true);
    }
  }

  const pros = {}, hsBy = new Map();
  const pool = Object.fromEntries(SKILL.map(p => [p, []]));
  for (const e of byG.values()) {
    const { np } = e, seasons = nfl.get(np.gsis_id);
    if (!isPro(np, seasons)) continue;
    const cid = e.live || e.cids[0]; // the live id, so his college page opens
    const rows = [...e.rows.values()].sort((a, b) => a.season - b.season);
    const last = rows[rows.length - 1];
    // class labels: ESPN lists each player's latest class (that of his last roster year, which can come after his last
    // season with stats) on every season, so count back from that year. The seed has every pro's raw final class; live
    // rows were already relabeled the same way.
    const cr = e.cids.map(c => seedClass(seed, c)).find(Boolean) || (CLASS_NUM[last.cls] ? [CLASS_NUM[last.cls], last.season] : null);
    if (cr) for (const s of rows) s.cls = CLS[Math.min(3, Math.max(0, cr[0] - 1 - (cr[1] - s.season)))];
    // high-school class = his first college roster year (the seed knows the years before the live window) or the live
    // eligibility estimate; a class year that needs an earlier one wins (JUCO transfers, careers that began before
    // 2004). Some old ESPN roster files list players who arrived years later (a 2008 LSU roster with 2021 freshmen),
    // so a roster year more than 3 years before his first season with stats is ignored. (Mission and COVID years
    // make a career longer than its class says, so the class never pushes the year later.)
    const firstStats = rows[0].season;
    const near = y => (y != null && y >= firstStats - 3 ? y : Infinity);
    let hs = Math.min(firstStats, ...e.cids.flatMap(c => [near(seed?.fr?.[c]), near(eligByCid.get(c)?.hs)]));
    const classHs = cr ? cr[1] - cr[0] + 1 : null;
    if (classHs != null && classHs < hs) hs = classHs;
    for (const c of e.cids) hsBy.set(c, hs);
    const pos = np.position === 'FB' ? 'RB' : np.position;
    pros[cid] = [np.display_name, pos, np.draft_year ?? null, np.draft_round ?? null, np.draft_pick ?? null,
      gsis2sid.get(np.gsis_id) || `g_${np.gsis_id}`, ...nflSummary(seasons)];
    for (const s of rows) if (s.sh && pool[s.pos]) pool[s.pos].push({ cid, s, yr: s.season - hs + 1, fin: s === last ? 1 : 0 });
  }

  const generated = new Date().toISOString(), from = seed?.from ?? liveFrom;
  // each season's typical number of team games (so far), for the page's volume check
  const teamGames = Object.fromEntries(Object.entries(seed?.teamGames || {}).filter(([y]) => Number(y) < liveFrom));
  for (const y of liveYears) teamGames[y] = bySeason[y].teamGames;
  for (const pos of SKILL) {
    const fields = ['cid', 'season', 'yr', 'fin', ...COMP_FIELDS[pos]];
    const rows = pool[pos].map(({ cid, s, yr, fin }) => [cid, s.season, yr, fin, ...COMP_FIELDS[pos].map(k => s[k] ?? null)]);
    const used = [...new Set(rows.map(r => r[0]))];
    fs.writeFileSync(path.join(out, `comps_${pos}.json`), JSON.stringify({
      meta: { pos, generated, from, to: current, features: COMP_FEATURES[pos], fields, proFields: PRO_FIELDS, teamGames },
      norms: norms[pos], pros: Object.fromEntries(used.map(c => [c, pros[c]])), rows,
    }));
  }

  // the board: each prospect's closest pro at the same stage, for his latest season with real volume
  const zPool = Object.fromEntries(SKILL.map(pos => [pos, pool[pos].map(r => ({ cid: r.cid, season: r.s.season, yr: r.yr, z: zVector(r.s, pos, norms[pos]) }))]));
  let tagged = 0;
  for (const p of prospects) {
    if (!p.cid || !zPool[p.pos]) continue;
    const list = (career.get(p.cid) || []).filter(s => show(s));
    const t = list[list.length - 1], hs = hsBy.get(p.cid) ?? eligByCid.get(p.cid)?.hs;
    if (!t || hs == null) continue;
    const [c] = findComps({ cid: p.cid, yr: t.season - hs + 1, z: zVector(t, p.pos, norms[p.pos]) }, zPool[p.pos], p.pos, { n: 1 });
    if (c) { p.pc = { cid: c.cid, n: pros[c.cid][0], s: c.season, sim: c.sim, ts: t.season }; tagged++; }
  }
  log(`  pro comps: ${Object.keys(pros).length} pros since ${from}; college seasons ${SKILL.map(p => `${p} ${pool[p].length}`).join(', ')}; board comps for ${tagged} prospects`);
}
