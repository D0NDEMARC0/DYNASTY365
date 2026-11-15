// Builds pipeline/comps_history.json.gz: every completed college season since 2004 of everyone who reached the NFL,
// for the pro comps, plus each season's norms. Builds use it for the years before the app's live college window (the
// last 8 seasons), and since it runs through the last completed season, that window can move forward for years
// before this needs re-running. Past seasons never change, so it runs once (about 900 MB of ESPN college
// play-by-play to download) and the result is committed. Run: node --max-old-space-size=6144 pipeline/comps-seed.mjs
import fs from 'node:fs';
import { loadSeason, percentilesForSeason } from './college.mjs';
import { nflPlayers } from './load.mjs';
import { nameKey } from './imports.mjs';
import { seasonNorms, hasVolume } from '../public/js/comps.js';
import { SKILL, ROW_HEAD, NFL_SKILL, seedRow, writeSeed, nflSeasons, isPro, linkPros, careerKey, SEED } from './comps.mjs';

const current = new Date().getFullYear();
// through the last completed college season: last year's (this year's is in progress, or hasn't started)
const FROM = Number(process.env.FROM || 2004), TO = Number(process.env.TO || current - 1);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const nfl = await nflSeasons(current, log);
const pros = (await nflPlayers()).filter(np => np.gsis_id && NFL_SKILL.has(np.position) && isPro(np, nfl.get(np.gsis_id)));
const ids = new Set(pros.filter(np => np.espn_id != null).map(np => String(np.espn_id))), names = new Set(pros.map(np => nameKey(np.display_name)));
log(`${pros.length} NFL QBs/RBs/WRs/TEs who were drafted or played a game`);

// keep every college season of anyone who could be one of them (same ESPN id, or same name); link once all are in
const norms = {}, teamGames = {}, firstRoster = new Map(), lastRoster = new Map(), cand = new Map();
for (let y = FROM; y <= TO; y++) {
  const res = await loadSeason(y, current);
  if (!res) { log(`${y}: no data`); continue; }
  percentilesForSeason(res.players, res.teamGames);
  const rows = [...res.players.values()];
  norms[y] = Object.fromEntries(SKILL.map(pos => [pos, seasonNorms(rows, pos)]));
  teamGames[y] = res.teamGames;
  for (const id of res.rosterIds) { if (!firstRoster.has(id)) firstRoster.set(id, y); lastRoster.set(id, y); }
  let kept = 0;
  for (const [cid, s] of res.players) {
    if ((s.pa || 0) + (s.car || 0) + (s.tgt || 0) + (s.rec || 0) === 0 || !(ids.has(cid) || names.has(nameKey(s.name)))) continue;
    if (!firstRoster.has(cid)) firstRoster.set(cid, y);
    s.sh = hasVolume(s, res.teamGames);
    if (!cand.has(cid)) cand.set(cid, []);
    cand.get(cid).push(s);
    kept++;
  }
  const inferred = rows.filter(s => s.ip).length;
  log(`${y}: ${res.players.size} skill players${inferred ? ` (positions inferred from stats for ${inferred})` : ''}, ${kept} possible pros; team games ${res.teamGames}`);
}

const link = linkPros(new Map([...cand].map(([cid, rows]) => [cid, careerKey(rows)])), pros);
// first and last college roster year (the last can come after his last season with stats: an opt-out or injury year)
const players = {}, fr = {}, lr = {};
let rowsOut = 0;
for (const [cid, np] of link) {
  const rows = cand.get(cid);
  for (const s of rows) {
    // seasons without ESPN positions: the NFL position settles WR vs TE, and a pass-catching back is a back
    if (s.ip && NFL_SKILL.has(np.position)) {
      const nflPos = np.position === 'FB' ? 'RB' : np.position;
      if ((s.pos === 'WR' || s.pos === 'TE') && (nflPos === 'WR' || nflPos === 'TE' || nflPos === 'RB')) s.pos = nflPos;
    }
  }
  players[cid] = { g: np.gsis_id, n: rows[rows.length - 1].name, r: rows.map(seedRow) };
  fr[cid] = firstRoster.get(cid);
  lr[cid] = lastRoster.get(cid);
  rowsOut += rows.length;
}
const byYear = {};
for (const p of Object.values(players)) for (const a of p.r) byYear[a[0]] = (byYear[a[0]] || 0) + 1;
log(`linked ${link.size} college players to NFL players (${rowsOut} seasons): ${Object.entries(byYear).map(([y, n]) => `${y} ${n}`).join(', ')}`);
writeSeed({ from: FROM, to: TO, generated: new Date().toISOString(), rowHead: ROW_HEAD, teamGames, norms, fr, lr, players });
log(`wrote ${SEED} (${(fs.statSync(SEED).size / 1e3).toFixed(0)} KB)`);
