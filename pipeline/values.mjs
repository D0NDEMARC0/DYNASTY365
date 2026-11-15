// Dynasty market values: FantasyCalc (values from real dynasty trades, format-aware); DynastyProcess (FantasyPros
// expert rankings) only fills in players FantasyCalc doesn't value.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedJSON } from './fetch.mjs';
import { dynastyProcessValues } from './load.mjs';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'out');

// League sizes pre-built for the static website (other sizes snap to the nearest one).
export const STATIC_TEAMS = [8, 10, 12, 14, 16];
export const STATIC_PPR = [0, 0.5, 1];
export const STATIC_QB = [1, 2];
// FantasyCalc's TE-premium tiers: none (0.25 or less per TE catch), te+ (0.5 to 1.0), te++ (over 1.0, or 2 TE starters).
// Only tight ends' values change between them. File suffix used for the static website's value files:
export const TEP_TIERS = { none: '', 'te+': '_tep1', 'te++': '_tep2' };

export async function marketValues({ qb, ppr, teams, tep = 'none' }) {
  if (!(tep in TEP_TIERS)) tep = 'none';
  const fc = await cachedJSON(
    `https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${qb}&numTeams=${teams}&ppr=${ppr}${tep === 'none' ? '' : `&tep=${encodeURIComponent(tep)}`}`,
    `fc_${qb}qb_${teams}_${ppr}${TEP_TIERS[tep]}.json`, 6);
  const players = {}, picks = {};
  for (const r of fc || []) {
    if (r.player.position === 'PICK') { picks[r.player.name] = r.value; continue; }
    if (!r.player.sleeperId) continue;
    players[r.player.sleeperId] = { fc: r.value, trend: r.trend30Day };
  }
  // Market = FantasyCalc, i.e. what players actually trade for in real dynasty leagues (format-specific).
  // DynastyProcess (FantasyPros expert rankings turned into values) disagrees with the trade market on whole groups
  // (it rates veteran QBs higher and young TEs lower), so it only fills in players FantasyCalc doesn't value,
  // placed on FantasyCalc's curve by rank so its different scale can't distort them.
  try {
    const { fp2sid } = JSON.parse(fs.readFileSync(path.join(OUT, 'idmap.json'), 'utf8'));
    const dp = (await dynastyProcessValues()).players;
    const key = qb === 2 ? 'value_2qb' : 'value_1qb';
    dp.filter(r => fp2sid[r.fp_id] && r[key]).sort((a, b) => b[key] - a[key]).forEach((r, i) => {
      const p = (players[fp2sid[r.fp_id]] ||= {});
      p.dpRank = i + 1; // expert-consensus rank, kept for reference
    });
  } catch (e) { console.warn('DynastyProcess values unavailable:', e.message); }
  const curve = Object.values(players).map(p => p.fc).filter(v => v != null).sort((a, b) => b - a);
  const valueAtRank = k => (k <= curve.length ? curve[k - 1] : Math.max(1, Math.round((curve[curve.length - 1] || 1) * 0.97 ** (k - curve.length))));
  for (const p of Object.values(players)) p.market = p.fc ?? (p.dpRank ? valueAtRank(p.dpRank) : 0);
  return { players, picks, format: { qb, ppr, teams, tep }, fetched: new Date().toISOString() };
}
