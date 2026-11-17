// NFL draft order "if the season ended today", from the current season's real results (nflverse schedule):
// worst record picks first; ties go to the easier strength of schedule (the NFL's first draft-order tiebreaker:
// the combined record of a team's opponents), then to the team name. The same order repeats each round; traded and
// compensatory picks aren't modeled.
import { cached, readCSV } from './fetch.mjs';

export async function draftOrder(season, log = () => {}) {
  const f = await cached('https://github.com/nflverse/nfldata/raw/master/data/games.csv', 'nfl_games.csv', 12);
  if (!f) return null;
  const games = readCSV(f).filter(g => Number(g.season) === season && g.game_type === 'REG');
  const rec = new Map(), opps = new Map();
  const team = t => { if (!rec.has(t)) rec.set(t, { w: 0, l: 0, t: 0 }); return rec.get(t); };
  let week = 0;
  for (const g of games) {
    team(g.away_team); team(g.home_team);
    (opps.get(g.away_team) || opps.set(g.away_team, []).get(g.away_team)).push(g.home_team);
    (opps.get(g.home_team) || opps.set(g.home_team, []).get(g.home_team)).push(g.away_team);
    if (g.home_score === '' || g.away_score === '' || g.home_score == null) continue;
    const hs = Number(g.home_score), as = Number(g.away_score);
    week = Math.max(week, Number(g.week));
    if (hs > as) { team(g.home_team).w++; team(g.away_team).l++; }
    else if (as > hs) { team(g.away_team).w++; team(g.home_team).l++; }
    else { team(g.home_team).t++; team(g.away_team).t++; }
  }
  if (!week) return null;
  const pct = r => (r.w + r.l + r.t ? (r.w + r.t / 2) / (r.w + r.l + r.t) : 0.5);
  // strength of schedule: every opponent on the full schedule, at their current record
  const sos = t => { const o = opps.get(t) || []; return o.length ? o.reduce((s, x) => s + pct(rec.get(x)), 0) / o.length : 0.5; };
  const teams = [...rec.keys()].map(t => ({ team: t, ...rec.get(t), pct: Math.round(pct(rec.get(t)) * 1000) / 1000, sos: Math.round(sos(t) * 1000) / 1000 }))
    .sort((a, b) => a.pct - b.pct || a.sos - b.sos || a.team.localeCompare(b.team));
  teams.forEach((t, i) => { t.pick = i + 1; });
  log(`  draft order from ${season} records through week ${week}: ${teams.slice(0, 3).map(t => `${t.team} ${t.w}-${t.l}${t.t ? `-${t.t}` : ''}`).join(', ')} pick first`);
  return { season, draft: season + 1, week, teams, generated: new Date().toISOString() };
}
