// Rookie consensus board + mock draft engine (generic league or your Sleeper league).
import { S, sleeper, tePremium } from './store.js';
import { buildTeams } from './views/league.js';

const market = p => (p.sid ? S.rowById.get(p.sid)?.market || null : null);

/**
 * How much earlier the k-th tight end of a class goes with a TE premium of pts per catch (k = 0 for the class's TE1).
 * Measured on past rookie classes ordered by FantasyCalc's values: with TE-premium values (TEP+ leagues give 0.5 to
 * 1.0 per catch, TEP++ more), the TE1 went about 25% earlier at TEP+ and 40% at TEP++, the TE2 20% and 30%, later tight
 * ends 5-15%. Per point that's about 0.42 for the TE1, 0.31 for the TE2, 0.12 for the TE3 and 0.09 after:
 * at +1 the TE1's slot ×0.66 (12th → 8th), the TE2's ×0.73, a TE4's ×0.91.
 */
const TE_K = [0.42, 0.31, 0.12, 0.09];
export const teFactor = (pts, k = 0) => Math.exp(-TE_K[Math.min(k, TE_K.length - 1)] * (pts || 0));
const fmtName = (qb, tep, base) => [qb === '1' ? '1QB' : qb === '2' ? 'SF' : '', tep ? 'TEP' : '', base ? 'your base' : ''].filter(Boolean).join(', ');

/**
 * How the market drafts each position: the average overall slot of the k-th QB/RB/WR/TE in recent rookie
 * classes, ordered by current dynasty value in this format (so superflex QB value is built in).
 */
function positionalCurves(history) {
  const classes = {};
  for (const p of history) if (market(p)) (classes[p.draftClass] ||= []).push(p);
  const acc = {};
  for (const cls of Object.values(classes)) {
    const k = {};
    cls.sort((a, b) => market(b) - market(a)).forEach((p, i) => {
      const j = (k[p.pos] = (k[p.pos] || 0) + 1) - 1;
      const a = ((acc[p.pos] ||= [])[j] ||= [0, 0]);
      a[0] += i + 1; a[1]++;
    });
  }
  const curves = {};
  for (const [pos, arr] of Object.entries(acc)) {
    let prev = 0;
    curves[pos] = arr.filter(Boolean).map(([s, n]) => (prev = Math.max(prev, s / n)));
  }
  return curves;
}

/**
 * How NFL draft capital turns into rookie-draft position, per position, in this format: past classes' players ranked
 * within their class by current dynasty value, fit as log(rank) ~ log(NFL pick). A deep QB class doesn't push its 7th
 * QB to where 7th QBs usually go: a QB taken around pick 25 is valued like one, however many QBs go before him.
 */
function capitalCurves(history) {
  const classes = {};
  for (const p of history) if (market(p) && p.draft?.p) (classes[p.draftClass] ||= []).push(p);
  const pts = {};
  for (const cls of Object.values(classes)) {
    cls.sort((a, b) => market(b) - market(a)).forEach((p, i) => (pts[p.pos] ||= []).push([Math.log(p.draft.p), Math.log(i + 1)]));
  }
  const fits = {};
  for (const [pos, a] of Object.entries(pts)) {
    if (a.length < 8) continue;
    const mx = a.reduce((s, x) => s + x[0], 0) / a.length, my = a.reduce((s, x) => s + x[1], 0) / a.length;
    let sxy = 0, sxx = 0;
    for (const [x, y] of a) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    const b = sxx ? sxy / sxx : 0;
    fits[pos] = { a: my - b * mx, b };
  }
  return fits;
}

/**
 * Projected NFL picks with NFL mock drafts you pasted (Tankathon, NFL Draft Buzz…) as the baseline: a player they list
 * is projected at their average pick, blended 70/30 (log scale) with the app's own projection (the online mock
 * consensus); one they leave out goes after everyone they list, unless the app already has him later. Then the same
 * pacing by position as the app's projections (slots: where the k-th at each position went in recent drafts) and one
 * player per pick. Returns Map(player -> pick).
 */
export function nflProjections(list, nflBoards, slots = {}) {
  const LAST = 257, est = new Map();
  let lastListed = 0;
  for (const p of list) {
    if (p.draft) continue;
    const picks = nflBoards.map(b => b.rank(p)).filter(v => v != null && v > 0);
    if (!picks.length) continue;
    const avg = Math.exp(picks.reduce((t, v) => t + Math.log(v), 0) / picks.length);
    lastListed = Math.max(lastListed, avg);
    est.set(p, p.proj?.pick ? Math.exp(0.7 * Math.log(avg) + 0.3 * Math.log(p.proj.pick)) : avg);
  }
  const past = Math.max(33, lastListed + 1);
  for (const p of list) if (!p.draft && !est.has(p) && p.proj?.pick) est.set(p, Math.max(p.proj.pick, past + p.proj.pick / 4));
  const byPos = {};
  for (const p of est.keys()) (byPos[p.pos] ||= []).push(p);
  for (const [pos, arr] of Object.entries(byPos)) {
    const sl = slots[pos] || [];
    arr.sort((a, b) => est.get(a) - est.get(b)).forEach((p, k) => {
      const floor = k < sl.length ? sl[k] : LAST;
      if (k > 0 && floor > est.get(p)) est.set(p, Math.exp(0.65 * Math.log(est.get(p)) + 0.35 * Math.log(floor)));
    });
  }
  const out = new Map(), taken = new Set();
  for (const p of [...est.keys()].sort((a, b) => est.get(a) - est.get(b))) {
    let k = Math.max(1, Math.round(est.get(p)));
    while (taken.has(k)) k++;
    taken.add(k);
    if (k <= LAST) out.set(p, k);
  }
  return out;
}

/**
 * Consensus order for a class, led by what people outside this app say: online NFL mock drafts and boards you pasted
 * (weight 1.6 each; the mocks 0.8 once you've pasted fantasy rankings, since they rank for the NFL draft), real
 * rookie-draft ADP (0.4), dynasty market value (0.3) and expert rankings (0.25). Our own models fill in behind them: the
 * expert-style projection (0.35), the projected NFL draft position (0.3), the Prospect Score (0.15) and the college
 * profile (0.5: production, breakout, age and recruiting without draft capital). Each signal becomes a slot within the class; the slots are blended by a weighted geometric mean,
 * re-normalized to whatever exists for each player. For a player the community has ranked, the models can move him
 * at most 2× either way from that ranking. Position-neutral signals are mapped onto the market's positional curve:
 * the 2nd-best RB by score takes about the slot where 2nd RBs usually go in this format.
 * TE premium works the same way: the curve comes from FantasyCalc's TE-premium market values, and every ranking made
 * without TE premium (the NFL mocks, expert ranks, ADP, projected NFL picks, boards you pasted for no TE premium)
 * moves tight ends up by teFactor(your premium, his place among the class's tight ends), so +1 moves them more than
 * +0.5 and the best tight ends the most. His place comes from the same board without TE premium.
 * Boards you paste can say which format they're for: one made for your format counts fully, one made for another
 * counts half, adjusted to yours (a 1QB board's QBs move up in superflex, a TE-premium board's TEs move down without it).
 */
export function consensus(list, { sf, tePts = tePremium(), history = [], boards = [], teOrder = null, W = {}, slots = null }) {
  // with TE premium, first rank the class without it to know which tight end is the TE1, TE2…
  if (tePts > 0 && !teOrder) {
    const k = new Map();
    consensus(list, { sf, tePts: 0, history, boards, W, slots }).board.filter(x => x.p.pos === 'TE').forEach((x, i) => k.set(x.p, i));
    return consensus(list, { sf, tePts, history, boards, teOrder: k, W, slots });
  }
  // NFL mock drafts you pasted set the projected NFL picks; your other boards are fantasy rankings
  const nflBoards = boards.filter(b => b.kind === 'nfl');
  boards = boards.filter(b => b.kind !== 'nfl');
  const nflMap = nflBoards.length ? nflProjections(list, nflBoards, slots || {}) : null;
  const rankBy = (get, asc) => {
    const have = list.filter(p => get(p) != null).sort((a, b) => (asc ? get(a) - get(b) : get(b) - get(a)));
    return new Map(have.map((p, i) => [p, i + 1]));
  };
  const curves = positionalCurves(history);
  // rankings made for 1QB without TE premium: QBs move up in superflex, tight ends with TE premium
  const teMul = p => teFactor(tePts, teOrder?.get(p) ?? TE_K.length);
  const teAdj = p => (p.pos === 'TE' ? teMul(p) : 1);
  const fmtAdj = p => (sf && p.pos === 'QB' ? 0.5 : 1) * teAdj(p);
  // Half "where the i-th QB/RB/WR/TE of a class usually goes in this format", half the overall rank, so a weak RB1
  // doesn't jump the class.
  const curveSlot = (pos, i, overall) => {
    const c = curves[pos] || [];
    if (!c.length) return overall;
    return 0.5 * (i < c.length ? c[i] : c[c.length - 1] + (i - c.length + 1) * 4) + 0.5 * overall;
  };
  // a signal's order within each position, placed on the market's positional curve
  const onCurve = (get, adj) => {
    const overall = rankBy(get, true);
    const slot = new Map(), byPos = {};
    for (const p of list) if (get(p) != null) (byPos[p.pos] ||= []).push(p);
    for (const [pos, arr] of Object.entries(byPos)) {
      arr.sort((a, b) => get(a) - get(b));
      arr.forEach((p, i) => slot.set(p, curveSlot(pos, i, overall.get(p) * (adj ? adj(p) : 1))));
    }
    return slot;
  };
  const scoreSlot = onCurve(p => (p.score == null ? null : -p.score));
  // college profile: his production, breakout, age and recruiting percentiles at the position, without draft capital
  // (the stats-and-pedigree case for him, which NFL draft order doesn't capture), on the market's positional curve
  const profile = p => {
    const c = p.comps, v = c ? [c.prod, c.brk, c.age, c.rec].filter(x => x != null) : [];
    return v.length >= 2 ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const profileSlot = onCurve(p => (p.draft || profile(p) == null ? null : -profile(p)));
  // the NFL mocks rank players for the NFL draft; once you've pasted fantasy rankings they count less
  const mockW = W.mock ?? (boards.length ? 0.8 : 1.6);
  // Online NFL mock-draft consensus (Pro Football Network's Mock Draft Index: the latest mocks' first round, weighted
  // 3:1 over the season-long top 40), as his projected NFL pick (spaced by position and one player per pick, see
  // pipeline/college.mjs). Half: where players at his position taken at that pick go in rookie drafts in this format
  // (capitalCurves); half: his place in the mocks' overall order. Players the mocks don't list come after everyone
  // they do.
  const capital = capitalCurves(history);
  const capSlot = (pos, pick) => { const f = capital[pos]; return f ? Math.exp(f.a + f.b * Math.log(Math.max(1, pick))) : pick; };
  const nflPick = p => (nflMap ? nflMap.get(p) ?? null : p.proj?.pick ?? p.mock?.est ?? null);
  const listed = p => !!p.mock || !!nflMap?.has(p);
  const mocked = list.filter(p => listed(p) && !p.draft && nflPick(p) != null).sort((a, b) => nflPick(a) - nflPick(b));
  const mockSlots = new Map();
  if (mocked.length) {
    // NFL mocks know nothing of TE premium: their overall half moves tight ends up (the capital half already has it)
    mocked.forEach((p, i) => mockSlots.set(p, 0.5 * capSlot(p.pos, nflPick(p)) + 0.5 * (i + 1) * teAdj(p)));
    for (const p of list) if (!p.draft && !mockSlots.has(p)) mockSlots.set(p, 0.5 * capSlot(p.pos, Math.max(70, nflPick(p) ?? 120)) + 0.5 * (mocked.length + 30) * teAdj(p));
  }
  // boards you pasted (KeepTradeCut, Draft Sharks, Dynasty Nerds, Reddit…): their ranks for the player, adjusted to
  // your format when a board was made for another one (which then counts half). A board that doesn't say is taken as
  // made without TE premium, like most published rankings, and doesn't touch QBs.
  const yourFmt = sf ? '2' : '1', tepOn = tePts > 0;
  const boardAdj = (b, p) => {
    let a = 1;
    if (p.pos === 'QB' && b.qb === '1' && sf) a = 0.5;
    if (p.pos === 'QB' && b.qb === '2' && !sf) a = 2;
    if (p.pos === 'TE') a *= b.tep ? teMul(p) / teFactor(0.75, teOrder?.get(p) ?? TE_K.length) : teMul(p); // TE-premium boards: taken as made for +0.75
    return a;
  };
  const boardW = b => ((b.qb && b.qb !== yourFmt) || !!b.tep !== tepOn ? 0.5 : 1);
  // one board for your format counts as much as the online mock consensus; two count 1.5×, three or more twice as much.
  // A board you mark as your base counts three times as much as your other boards, and your boards then count about as
  // much as every other signal together: the order starts from it, and the rest still move players up or down.
  const based = boards.some(b => b.base);
  const boardsWeight = based ? 3.5 : 1.6 * Math.min(2, 0.5 + 0.5 * boards.reduce((t, b) => t + boardW(b), 0));
  const yours = p => {
    let n = 0, d = 0;
    for (const b of boards) {
      const r = (b.blendRank || b.rank)(p);
      if (r == null) continue;
      const w = boardW(b) * (b.base ? 3 : 1);
      n += Math.log(Math.max(1, r * boardAdj(b, p))) * w; d += w;
    }
    return d ? Math.exp(n / d) : null;
  };
  // community: what people outside this app say (for the mocks, only the players they actually list)
  const all = () => true;
  const signals = [
    { label: `your pasted board${boards.length === 1 ? '' : 's'} (${boards.map(b => (fmtName(b.qb, b.tep, b.base) ? `${b.name}: ${fmtName(b.qb, b.tep, b.base)}` : b.name)).join(', ')})`, w: boardsWeight, m: rankBy(yours, true), community: all },
    { label: nflMap ? `NFL mock drafts (your pasted ${nflBoards.map(b => b.name).join(', ')}, with the online consensus)` : 'online NFL mock-draft consensus (Pro Football Network)', w: mockW, m: mockSlots, community: listed },
    { label: 'rookie ADP', w: 0.4, m: rankBy(p => p.adp?.rookie ?? null, true), adj: teAdj, community: all },
    { label: 'market value', w: 0.3, m: rankBy(market, false), community: all },
    // FantasyPros rookie rankings are 1QB without TE premium: QBs move up in superflex, TEs with TE premium
    { label: 'expert rankings', w: 0.25, m: rankBy(p => p.ecr?.rank ?? null, true), adj: fmtAdj, community: all },
    // before FantasyPros ranks a class: a model of how its experts ranked past classes from the same profile
    // (pedigree, production, age, school, size, Wikipedia attention), placed on the market's positional curve
    { label: 'expert-style projection (on the market’s positional curve)', w: 0.35, m: onCurve(p => (p.ecr ? null : p.xecr ?? null), fmtAdj) },
    // before the NFL Draft: where the draft-capital model projects him in the real draft (players it projects as
    // undrafted come after everyone it projects to be picked)
    { label: 'projected NFL draft position', w: 0.3, m: rankBy(p => (p.draft || !p.proj ? null : p.proj.pick ?? 300 + p.proj.rank), true), adj: teAdj },
    { label: Object.keys(curves).length ? 'Prospect Score (on the market’s positional curve)' : 'Prospect Score', w: 0.15, m: scoreSlot },
    { label: 'college profile: production, breakout, age, recruiting (on the market’s positional curve)', w: W.profile ?? 0.5, m: profileSlot },
  ];
  const slotOf = (s, p) => { const r = s.m.get(p); return r == null ? null : Math.max(1, r * (s.adj ? s.adj(p) : 1)); };
  // weighted geometric mean of the slots: one source ranking a player 250th can't bury a #2 from the others
  const out = [];
  for (const p of list) {
    let cn = 0, cd = 0;
    for (const s of signals) { const r = s.community?.(p) ? slotOf(s, p) : null; if (r != null) { cn += Math.log(r) * s.w; cd += s.w; } }
    const anchor = cd ? Math.exp(cn / cd) : null;
    let num = 0, den = 0;
    const parts = []; // each source's slot for him and its weight, to show how his rank was built
    for (const s of signals) {
      let r = slotOf(s, p);
      if (r == null) continue;
      // our models stay secondary: at most 2× either way from what outside sources say
      if (!s.community && anchor) r = Math.min(anchor * 2, Math.max(anchor / 2, r));
      num += Math.log(r) * s.w; den += s.w;
      parts.push({ label: s.label, slot: r, w: s.w });
    }
    if (!den) continue;
    out.push({ p, slot: Math.exp(num / den), parts });
  }
  out.sort((a, b) => a.slot - b.slot);
  out.forEach((x, i) => { x.rank = i + 1; });
  return { board: out, used: signals.filter(s => s.m.size).map(s => s.label), nfl: nflMap };
}

/** Generic league: linear rookie draft, team 1 picks first each round. */
export function genericSlots(teams, rounds) {
  const slots = [];
  for (let r = 1; r <= rounds; r++) for (let i = 1; i <= teams; i++) slots.push({ round: r, pick: i, team: `Team ${i}` });
  return { slots, source: `${teams}-team linear draft` };
}

/** Your Sleeper league: real draft order when set, otherwise projected from standings; traded picks applied. */
export async function leagueSlots(cls, roundsOverride) {
  const L = S.league;
  const teams = buildTeams();
  const byRid = new Map(teams.map(t => [t.rosterId, t]));
  let drafts = [];
  try { drafts = await sleeper(`/league/${L.info.league_id}/drafts`); } catch { /* offline: project */ }
  const d = (drafts || []).find(x => String(x.season) === String(cls) && x.status !== 'complete');
  let order = null, source;
  if (d?.slot_to_roster_id && Object.keys(d.slot_to_roster_id).length) {
    order = Object.entries(d.slot_to_roster_id).sort((a, b) => a[0] - b[0]).map(([, rid]) => Number(rid));
    source = 'your league’s draft order';
  } else if (d?.draft_order && Object.keys(d.draft_order).length) {
    const byUser = new Map(L.rosters.map(r => [r.owner_id, r.roster_id]));
    order = Object.entries(d.draft_order).sort((a, b) => a[1] - b[1]).map(([uid]) => byUser.get(uid)).filter(Boolean);
    source = 'your league’s draft order';
  }
  if (!order || order.length !== L.rosters.length) {
    order = [...L.rosters].sort((a, b) => ((a.settings?.wins || 0) - (b.settings?.wins || 0))
      || ((a.settings?.fpts || 0) + (a.settings?.fpts_decimal || 0) / 100) - ((b.settings?.fpts || 0) + (b.settings?.fpts_decimal || 0) / 100)).map(r => r.roster_id);
    source = 'order projected from current standings (worst record picks first)';
  }
  const rounds = roundsOverride || d?.settings?.rounds || L.info.settings?.draft_rounds || 4;
  const owner = new Map();
  for (const t of L.traded) if (String(t.season) === String(cls)) owner.set(`${t.round}|${t.roster_id}`, t.owner_id);
  const needs = rid => {
    const t = byRid.get(rid);
    if (!t?.roomRank) return {};
    const worst = Object.entries(t.roomRank).sort((a, b) => b[1] - a[1]).map(([pos]) => pos);
    return { [worst[0]]: 2, [worst[1]]: 1 };
  };
  const slots = [];
  for (let r = 1; r <= rounds; r++) order.forEach((orig, i) => {
    const own = owner.get(`${r}|${orig}`) ?? orig;
    slots.push({ round: r, pick: i + 1, team: byRid.get(own)?.name || `Team ${own}`, via: own !== orig ? byRid.get(orig)?.name || `Team ${orig}` : null,
      me: !!byRid.get(own)?.me, needs: needs(own) });
  });
  return { slots, source };
}

/** Each pick takes the best available, nudged toward a team's weakest positions (league mocks only). */
export function runMock(board, slots) {
  const avail = [...board];
  return slots.map(slot => {
    let best = 0, bestCost = Infinity;
    for (let i = 0; i < Math.min(5, avail.length); i++) {
      const cost = i - (slot.needs?.[avail[i].p.pos] || 0);
      if (cost < bestCost) { bestCost = cost; best = i; }
    }
    const [pickd] = avail.splice(best, 1);
    return { ...slot, x: pickd || null };
  });
}
