// "Pro comps" card for the college player page: the former and current NFL players whose college season looked most
// like his at the same stage of college, what they did in the NFL, and a side-by-side for any comp (or any pro you
// look up). The matching is ../comps.js, shared with the data build (the board's Pro comp column).
import { S } from '../store.js';
import { fetchData } from '../version.js';
import { CM, fmtC } from '../college.js';
import { COMP_FEATURES, derive, zVector, findComps, distance2, gaps, stage, similarity, hasVolume } from '../comps.js';
import { ordinal } from '../model.js';
import { esc, fmtInt, fmt1, heat, nameMatch } from '../ui.js';

const pools = {};
/** The comp pool for a position: every college season with real volume by someone who reached the NFL. */
export function loadPool(pos) {
  pools[pos] ||= fetchData(`data/comps_${pos}.json`).then(r => (r.ok ? r.json() : null)).then(d => (d ? prepare(d) : null)).catch(() => null);
  return pools[pos];
}
function prepare(d) {
  const { fields, proFields, pos } = d.meta;
  const pros = new Map(Object.entries(d.pros).map(([cid, a]) => [cid, { cid, ...Object.fromEntries(proFields.map((k, i) => [k, a[i]])) }]));
  const byCid = new Map();
  const rows = d.rows.map(a => {
    const s = { pos, ...Object.fromEntries(fields.map((k, i) => [k, a[i]])) };
    const r = { cid: s.cid, season: s.season, yr: s.yr, fin: s.fin, s, z: zVector(s, pos, d.norms) };
    if (!byCid.has(r.cid)) byCid.set(r.cid, []);
    byCid.get(r.cid).push(r);
    return r;
  });
  return { meta: d.meta, norms: d.norms, pros, rows, byCid };
}

// labels and formats for the derived comp stats (the rest come from the college metric dictionary)
const d1 = v => (v == null ? '—' : v.toFixed(1)), d2 = v => (v == null ? '—' : v.toFixed(2)), pc = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const TIER = { 1: 'Power 4', 0: 'Group of 5', '-1': 'FCS' };
const EXTRA = {
  reypg: ['Rec yds/G', d1, 'Receiving yards per game'], recpg: ['Rec/G', d1, 'Receptions per game'], retdpg: ['Rec TD/G', d2, 'Receiving touchdowns per game'],
  tdpg: ['TD/G', d2, 'Rushing + receiving touchdowns per game'], pypg: ['Pass yds/G', d1, 'Passing yards per game'], ptdr: ['TD %', pc, 'Passing touchdowns per attempt'],
  intr: ['INT %', pc, 'Interceptions per attempt (lower is better)'], rutdpg: ['Rush TD/G', d2, 'Rushing touchdowns per game'],
  tierN: ['Competition', v => TIER[v] ?? '—', 'Level of competition: Power 4 (incl. the old Power 5), Group of 5, or FCS'],
  ht: ['Height', v => (v ? `${Math.floor(v / 12)}'${v % 12}"` : '—'), 'Listed height'], wt: ['Weight', v => (v ? `${v} lb` : '—'), 'Listed weight'],
};
const label = k => EXTRA[k]?.[0] ?? CM[k]?.label ?? k;
const fmtK = (k, v) => (EXTRA[k] ? EXTRA[k][1](v) : fmtC(k, v));
const descK = k => EXTRA[k]?.[2] ?? CM[k]?.desc ?? '';
const LOWER = new Set(['skr', 'stuff', 'intr']);
const pctOfZ = z => 100 / (1 + Math.exp(-1.702 * z)); // standard normal CDF, close enough for shading
const KEY = { WR: ['dom', 'yptpa', 'yprr', 'tsh'], TE: ['dom', 'yptpa', 'yprr', 'tsh'], RB: ['scsh', 'ypc', 'exp10', 'tsh'], QB: ['epap', 'cpoe', 'ypa', 'rypg'] };

const yrWord = y => (y == null ? 'unknown year' : y >= 5 ? '5th+ year of college' : `${ordinal(y)} year out of high school`);
const yrShort = y => (y == null ? '' : y >= 5 ? '5th+ yr' : `${ordinal(y)} yr`);
const statLine = (pos, s) => (pos === 'QB'
  ? `${fmtInt(s.pyd)} yds · ${s.ptd ?? 0} TD · ${s.int ?? 0} INT${s.qruyd ? ` · ${fmtInt(s.qruyd)} rush` : ''}`
  : pos === 'RB' ? `${fmtInt(s.car)}–${fmtInt(s.ruyd)}–${s.rutd ?? 0}${s.rec ? ` · ${s.rec} rec` : ''}`
    : `${s.rec ?? 0}–${fmtInt(s.reyd)}–${s.retd ?? 0}`);
const lineTitle = pos => (pos === 'QB' ? 'Passing yards, TDs, INTs and rushing yards (no sacks)' : pos === 'RB' ? 'Carries–rushing yards–rushing TDs, receptions' : 'Receptions–yards–TDs');
const draftTxt = p => (p.draftYear ? `${p.draftYear} R${p.round} · #${p.pick}` : 'Undrafted');
// a recent draftee may not have played yet; anyone else simply never did
const recent = p => (p.draftYear ?? 0) >= (S.meta?.current ?? 0) - 1;
const bestTxt = p => (p.bestRank ? `#${p.bestRank} ${esc(p.nflPos)} in ${p.bestYear} <span class="muted small">${fmt1(p.bestPpg)} PPG</span>` : `<span class="muted">no NFL games${recent(p) ? ' yet' : ''}</span>`);
const proLink = p => (S.byId.has(p.id) ? `<a class="link" href="#/player/${encodeURIComponent(p.id)}">${esc(p.name)}</a>` : esc(p.name));
function careerTxt(p) {
  const d = p.draftYear ? `Drafted in ${p.draftYear}, round ${p.round} (pick ${p.pick})` : 'Undrafted';
  if (!p.g) return `${d}; no NFL regular-season games${recent(p) ? ' yet' : ''}.`;
  return `${d}. ${p.g} NFL games (${p.first}${p.last !== p.first ? `–${p.last}` : ''}), ${fmt1(p.ppg)} PPR points per game. Best finish: #${p.bestRank} ${esc(p.nflPos)} in ${p.bestYear} (${fmt1(p.bestPpg)} PPG). ${p.top12} top-12 and ${p.top24} top-24 PPR seasons.`;
}
const closeness = g => (g == null ? '<span class="muted">—</span>'
  : `<span class="gap g${g < 0.3 ? 3 : g < 0.7 ? 2 : g < 1.2 ? 1 : 0}" title="${g.toFixed(2)} standard deviations apart">${g < 0.3 ? '●●●' : g < 0.7 ? '●●○' : g < 1.2 ? '●○○' : '○○○'}</span>`);

/**
 * Fill `host` with the card. career: his college seasons (from the career files); hs: his high-school class year.
 */
export async function proCompsCard(host, { cid, name, pos, career, hs }) {
  if (!host || !COMP_FEATURES[pos]) return;
  host.innerHTML = '<div class="card"><h2>Pro comps</h2><p class="muted"><span class="spinner"></span> Loading the pro comparison pool…</p></div>';
  const data = await loadPool(pos);
  if (!data) { host.innerHTML = ''; return; }
  const { teamGames = {}, from, to } = data.meta;
  const own = data.byCid.get(cid) || [];
  const yrOf = s => own.find(r => r.season === s.season)?.yr ?? (hs != null ? s.season - hs + 1 : null);
  const seasons = career.filter(s => s.pos === pos && data.norms[s.season] && hasVolume(s, teamGames[s.season]));
  if (!seasons.length) {
    host.innerHTML = `<div class="card"><h2>Pro comps</h2><p class="muted">No college season with enough volume to compare yet (a ${pos} needs about ${pos === 'QB' ? '8 pass attempts' : pos === 'RB' ? '4 carries + targets' : pos === 'TE' ? '1.5 targets' : '2 targets'} per team game).</p></div>`;
    return;
  }
  const st = { season: seasons[seasons.length - 1].season, mode: 'same', sel: null, q: '' };
  const nflNow = S.meta?.current ?? to;

  host.innerHTML = `<div class="card comps">
    <div class="chead">
      <div><h2 style="margin:0">Pro comps</h2><p class="muted small" style="margin:3px 0 0">Former and current NFL players whose college season looked most like his, and what they did in the NFL</p></div>
      <div class="toolbar" style="margin:0">
        <div class="seg" data-k="season">${seasons.map(s => `<button data-v="${s.season}">${s.season}${yrOf(s) ? ` · ${yrShort(yrOf(s))}` : ''}</button>`).join('')}</div>
        <div class="seg" data-k="mode"><button data-v="same" title="Only pro seasons from the same year out of high school (a true sophomore vs. true sophomores)">Same year in college</button><button data-v="any" title="Any college season of a pro; seasons from a different year of college count as less alike">Any year</button></div>
      </div>
    </div>
    <p class="small" data-desc style="margin:0 0 8px"></p>
    <div class="tablewrap" style="box-shadow:none" data-list></div>
    <p class="small" data-sum style="margin:8px 0 0"></p>
    <div data-detail></div>
    <div class="cmpfind"><input type="search" data-k="q" placeholder="Compare with any pro: type a name (e.g. Ja'Marr Chase)" aria-label="Compare with any pro"><div data-found></div></div>
    <p class="muted small" style="margin:12px 0 0">How it works: each stat is measured against that season’s qualified FBS ${pos}s, so different eras compare fairly. Role and production count most (${pos === 'QB' ? 'EPA per play, yards per attempt, passing and rushing yards per game' : pos === 'RB' ? 'share of team scrimmage yards, carry share, scrimmage yards per game' : 'dominator, yards per team pass attempt, target share, yards per game'}), then efficiency and style, then size and level of competition. Similarity 100 = identical; two typical qualified ${pos}s score about 35. Pros = drafted or played an NFL game. College seasons ${from}–${to - 1}${to ? ` plus ${to} so far` : ''} from ESPN via sportsdataverse (before 2014 ESPN lists no positions, so they’re read from each player’s stats). NFL results: nflverse, regular season, PPR.</p>
  </div>`;
  const $ = s => host.querySelector(s);
  const target = () => {
    const t = seasons.find(s => s.season === st.season);
    return { t, yr: yrOf(t), z: zVector(t, pos, data.norms) };
  };
  const simTo = (tz, ty, r) => { const d = distance2(tz, r.z, pos, ty != null && r.yr != null ? stage(ty) - stage(r.yr) : 0); return d == null ? null : similarity(d); };

  const drawDetail = () => {
    const { t, yr, z } = target();
    const r = st.sel && (data.byCid.get(st.sel.cid) || []).find(x => x.season === st.sel.season);
    if (!r) { $('[data-detail]').innerHTML = ''; return; }
    const p = data.pros.get(r.cid), dt = derive(t), dc = derive(r.s), g = gaps(z, r.z, pos);
    const sim = simTo(z, yr, r);
    const shade = (k, zv) => (zv == null || k === 'tierN' ? '' : heat(LOWER.has(k) ? 100 - pctOfZ(zv) : pctOfZ(zv)));
    const others = (data.byCid.get(r.cid) || []).map(x => `<button data-pick="${esc(x.cid)}" data-s="${x.season}" class="${x.season === r.season ? 'on' : ''}">${x.season} · ${yrShort(x.yr)}</button>`).join('');
    $('[data-detail]').innerHTML = `<div class="cmp-detail">
      <div class="chead" style="margin-bottom:6px">
        <h3 style="margin:0">${esc(name)} ${t.season} vs. ${proLink(p)} ${r.season}${sim != null ? ` <span class="muted small">similarity ${sim}${stage(r.yr) !== stage(yr) ? ' (different year of college)' : ''}</span>` : ''}</h3>
        ${others.includes('</button><button') ? `<div class="seg small" data-k="pseason" title="${esc(p.name)}’s other college seasons">${others}</div>` : ''}
      </div>
      <div class="tablewrap" style="box-shadow:none"><table class="data"><thead><tr><th>Stat</th><th class="n">${esc(name)} · ${t.season}</th><th class="n">${esc(p.name)} · ${r.season}</th><th>Match</th></tr></thead><tbody>
        <tr><td>School · year</td><td class="n">${esc(t.team || '—')} · ${yrShort(yr)}</td><td class="n">${esc(r.s.team || '—')} · ${yrShort(r.yr)}${r.fin ? ' · final season' : ''}</td><td></td></tr>
        <tr><td title="${esc(lineTitle(pos))}">Line</td><td class="n">${statLine(pos, t)} <span class="muted small">${t.g} G</span></td><td class="n">${statLine(pos, r.s)} <span class="muted small">${r.s.g} G</span></td><td></td></tr>
        ${COMP_FEATURES[pos].map(([k], i) => `<tr><td title="${esc(descK(k))}">${label(k)}</td>
          <td class="n heat" style="${shade(k, z[i])}">${fmtK(k, dt[k])}</td><td class="n heat" style="${shade(k, r.z[i])}">${fmtK(k, dc[k])}</td><td>${closeness(g[i].gap)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="small" style="margin:8px 0 0"><b>${proLink(p)} in the NFL:</b> ${careerTxt(p)}</p>
      <p class="muted small" style="margin:4px 0 0">Shading = that season vs. qualified FBS ${pos}s the same year (blue above average, red below). ●●● = within 0.3 standard deviations.</p>
    </div>`;
  };

  const draw = () => {
    host.querySelectorAll('.seg[data-k="season"] button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === st.season));
    host.querySelectorAll('.seg[data-k="mode"] button').forEach(b => b.classList.toggle('on', b.dataset.v === st.mode));
    const { t, yr, z } = target();
    const comps = findComps({ cid, yr, z }, data.rows, pos, { mode: st.mode, n: 10 });
    if (!st.sel && comps[0]) st.sel = { cid: comps[0].cid, season: comps[0].season };
    const ty = stage(yr);
    const nPros = new Set(data.rows.filter(r => st.mode === 'any' || stage(r.yr) === ty).map(r => r.cid)).size;
    const live = t.season === to ? `, ${t.g} games so far` : '';
    $('[data-desc]').innerHTML = st.mode === 'same'
      ? `<b>${esc(name)}’s ${t.season}</b> (${yrWord(yr)}${live}) vs. the ${ty >= 5 ? '5th-year-or-later' : `${ordinal(ty)}-year`} college seasons of ${fmtInt(nPros)} ${pos}s who reached the NFL.`
      : `<b>${esc(name)}’s ${t.season}</b> (${yrWord(yr)}${live}) vs. every college season of ${fmtInt(nPros)} ${pos}s who reached the NFL; seasons from a different year of college count as less alike.`;
    const P = c => data.pros.get(c.cid);
    const rowsHtml = comps.map(c => {
      const p = P(c), s = c.s, ds = derive(s), mkt = S.rowById.get(p.id)?.market;
      const sel = st.sel?.cid === c.cid && st.sel?.season === c.season;
      return `<tr data-c="${esc(c.cid)}" data-s="${c.season}"${sel ? ' class="sel"' : ''}>
        <td class="n heat" style="${heat(c.sim)}" title="Similarity, 0–100"><b>${c.sim}</b></td>
        <td>${proLink(p)}</td>
        <td>${c.season} <span class="muted small">${esc(s.team || '')} · ${yrShort(c.yr)}${c.fin ? ' · final' : ''}</span></td>
        <td class="n">${statLine(pos, s)}</td>
        ${KEY[pos].map(k => `<td class="n">${fmtK(k, ds[k])}</td>`).join('')}
        <td class="n">${draftTxt(p)}</td>
        <td>${bestTxt(p)}</td>
        <td class="n">${p.g ? `${p.top12} / ${p.top24}` : '—'}</td>
        <td class="n">${mkt ? fmtInt(mkt) : '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join('');
    $('[data-list]').innerHTML = comps.length ? `<table class="data"><thead><tr>
        <th class="n" title="How alike the two college seasons are, 0–100">Sim</th><th>Pro</th><th>College season</th><th class="n" title="${esc(lineTitle(pos))}">Line</th>
        ${KEY[pos].map(k => `<th class="n" title="${esc(descK(k))}">${label(k)}</th>`).join('')}
        <th class="n">NFL draft</th><th title="Best season by total PPR points at his NFL position">Best NFL finish</th><th class="n" title="NFL seasons finishing top 12 / top 24 at his position in PPR points">Top 12 / 24</th><th class="n" title="Dynasty market value today (FantasyCalc, your format)">Value</th>
      </tr></thead><tbody>${rowsHtml}</tbody></table>` : '<p class="muted" style="padding:8px">No pro seasons to compare with at this stage of college.</p>';
    if (comps.length) {
      const drafted = comps.filter(c => P(c).draftYear).length, early = comps.filter(c => P(c).round != null && P(c).round <= 2).length;
      const t24 = comps.filter(c => P(c).top24 > 0).length, t12 = comps.filter(c => P(c).top12 > 0).length;
      const young = comps.filter(c => (P(c).draftYear ?? P(c).first ?? 0) >= nflNow - 1).length;
      const hit = pos === 'QB' || pos === 'TE' ? `${t12} had a top-12 ${pos} season` : `${t24} had a top-24 ${pos} season (${t12} top-12)`;
      $('[data-sum]').innerHTML = `Of these ${comps.length}: ${drafted} drafted (${early} in rounds 1–2), and ${hit} in PPR.${young ? ` ${young} ${young === 1 ? 'is' : 'are'} still in ${young === 1 ? 'his' : 'their'} first two NFL seasons.` : ''} <span class="muted">Click a row for the side-by-side.</span>`;
    } else $('[data-sum]').innerHTML = '';
    drawDetail();
  };

  const drawFound = () => {
    const q = st.q.trim();
    const found = q.length < 2 ? [] : [...data.pros.values()].filter(p => nameMatch(p.name, q)).slice(0, 10);
    $('[data-found]').innerHTML = q.length < 2 ? '' : found.length
      ? found.map(p => `<button class="btn" data-find="${esc(p.cid)}">${esc(p.name)} <span class="muted small">${esc(p.nflPos || pos)} · ${p.draftYear ?? 'UDFA'}</span></button>`).join('')
      : `<span class="muted small">No ${pos} in the pro pool matches “${esc(q)}” (it has ${pos}s with a college season since ${from}).</span>`;
  };

  host.addEventListener('click', e => {
    const b = e.target.closest('button');
    const seg = b?.closest('.seg');
    if (seg?.dataset.k === 'season') { st.season = Number(b.dataset.v); st.sel = null; draw(); return; }
    if (seg?.dataset.k === 'mode') { st.mode = b.dataset.v; st.sel = null; draw(); return; }
    if (b?.dataset.pick) { st.sel = { cid: b.dataset.pick, season: Number(b.dataset.s) }; drawDetail(); return; }
    if (b?.dataset.find) {
      // that pro's college season closest to this one (a different year of college counts as less alike)
      const { yr, z } = target();
      const best = (data.byCid.get(b.dataset.find) || []).map(r => ({ r, sim: simTo(z, yr, r) ?? -1 })).sort((x, y) => y.sim - x.sim)[0];
      if (best) { st.sel = { cid: best.r.cid, season: best.r.season }; drawDetail(); host.querySelector('[data-detail]').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      return;
    }
    const tr = e.target.closest('tr[data-c]');
    if (tr && !e.target.closest('a')) {
      st.sel = { cid: tr.dataset.c, season: Number(tr.dataset.s) };
      host.querySelectorAll('tr[data-c]').forEach(x => x.classList.toggle('sel', x === tr));
      drawDetail();
    }
  });
  host.addEventListener('input', e => { if (e.target.dataset.k === 'q') { st.q = e.target.value; drawFound(); } });
  draw();
}
