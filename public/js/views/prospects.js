// Rookie & prospect classes: big board (plus boards you paste), Prospect Score, consensus rankings, ADP and mock drafts.
import { S, rows, tePremium } from '../store.js';
import { loadProspects, loadPahowdy, collegeHeadshot, stars, mockText } from '../college.js';
import { consensus, genericSlots, leagueSlots, runMock } from '../mock.js';
import { userBoards, addBoard, removeBoard, updateBoard } from '../boards.js';
import { ordinal } from '../model.js';
import { esc, fmtInt, fmt1, heat, posTag, table, sortRows, nameMatch } from '../ui.js';
import { mount } from './common.js';

const st = { cls: null, view: null, pos: 'ALL', q: '', sort: 'mock', dir: 'asc', limit: 150, rounds: 4, mockSrc: 'league', adding: false, msg: '' };
const VIEWS = ['board', 'rankings', 'mock'];
// other public boards, for comparison (links only — their content isn't copied into this app)
const OTHER_BOARDS = [
  ['PFN mock draft index', cls => `https://www.profootballnetwork.com/nfl-draft-hq/mock-draft-index?year=${cls}`],
  ['FantasyPros devy consensus (free)', 'https://www.fantasypros.com/2026/01/devy-fantasy-football-rankings-2026'],
  ['KeepTradeCut devy', 'https://keeptradecut.com/devy-rankings'],
  ['KeepTradeCut rookies', 'https://keeptradecut.com/dynasty-rankings/rookie-rankings'],
  ['Draft Sharks TE premium', 'https://www.draftsharks.com/dynasty-rankings/te-premium'],
  ['Dynasty Nerds rookies', 'https://www.dynastynerds.com/dynasty-rankings/rookies/'],
  ['Dynasty League Football', 'https://dynastyleaguefootball.com/rankings/'],
  ['Footballguys rookies', 'https://www.footballguys.com/rankings/duration/dynasty-rookie'],
  ['RotoBaller rookies', 'https://www.rotoballer.com/dynasty-rookie-rankings'],
  ['Footballguys devy', 'https://www.footballguys.com/rankings/duration/devy'],
  ['Draft Sharks rookies', 'https://www.draftsharks.com/dynasty-rankings/rookies/superflex'],
  ['FantasyPros rookies', 'https://www.fantasypros.com/nfl/rankings/dynasty-rookies-overall.php'],
  ['r/DynastyFF', 'https://www.reddit.com/r/DynastyFF/search/?q=devy%20rankings&restrict_sr=1&sort=new'],
];

const eligCell = (p, cls) => (p.elig == null ? '—' : p.elig < cls ? `${p.elig} <span class="muted small">returned</span>` : String(p.elig));
const projCell = p => {
  if (!p.proj) return '—';
  const model = p.proj.model ? `#${p.proj.model}` : 'undrafted';
  const tip = p.proj.model === undefined ? '' : ` title="${esc(p.mock ? `From the online mocks (${mockText(p.mock)}). Our stats model alone: ${model}` : `Not in the online mocks · our stats model ${model}, placed after the mocks’ top 40`)}"`;
  return p.proj.pick ? `<span${tip}>R${p.proj.round} · #${p.proj.pick}</span>` : `<span class="muted"${tip}>UDFA</span>`;
};
const ageCell = p => (p.age != null ? `${p.ageEst ? '~' : ''}${fmt1(p.age)}` : '—');
// closest pro at the same stage of college, for his latest season with real volume (see the player page for 10)
const compCell = p => (!p.pc ? '<td class="small muted">—</td>'
  : `<td class="small" title="${esc(`${p.pc.n}’s ${p.pc.s} college season is the closest match to his ${p.pc.ts} by a player who reached the NFL, at the same year of college (similarity ${p.pc.sim}/100). Open his page for the 10 closest and what they did in the NFL.`)}">${esc(p.pc.n)} <span class="muted">’${String(p.pc.s).slice(2)} · ${p.pc.sim}</span></td>`);
const COMP_TITLE = 'The NFL player (former or current) whose college season at the same year of college looked most like this player’s latest season, and how alike (0–100). Open a player for his 10 closest comps and their NFL results';
const brkNote = p => (p.brk?.cls ? ` <span class="muted small">${p.brk.age ? `${p.brk.est ? '~' : ''}${fmt1(p.brk.age)}` : esc(p.brk.cls)}</span>` : '');

export async function render(root, params, query) {
  const el = mount(root);
  el.innerHTML = '<div class="empty"><span class="spinner"></span> Loading prospects…</div>';
  let data;
  try { data = await loadProspects(); } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  rows();
  const { meta } = data;
  const classes = Object.keys(meta.classes).map(Number).sort((a, b) => b - a);
  if (query.class) st.cls = Number(query.class);
  if (!classes.includes(st.cls)) st.cls = classes.includes(meta.upcoming) ? meta.upcoming : classes[0]; // open on the next draft class
  const status = meta.classes[st.cls]?.status;
  const pre = status !== 'drafted';
  st.view = VIEWS.includes(query.view) ? query.view : pre ? 'board' : 'rankings';
  const sf = S.settings.qb === 2;
  const tep = tePremium();
  const fmtName = `${sf ? 'superflex' : '1QB'}${tep ? `, TE premium +${tep}` : ''}`;
  const teams = S.settings.teams || 12;
  const classList = data.prospects.filter(p => p.draftClass === st.cls);
  const boards = userBoards(st.cls, classList);
  const history = data.prospects.filter(p => p.status === 'drafted' && p.draftClass !== st.cls);
  const { board, used } = consensus(classList, { sf, history, boards });
  const mockRank = new Map(board.map(x => [x.p, x.rank]));
  const drafts = meta.draftModel?.drafts || [];
  // Pahowdy's pre-draft score: only in the copy of the app on your computer (personal-use data)
  const ph = S.mode === 'server' ? await loadPahowdy() : null;
  const phOf = p => (ph ? (p.cid && ph.byCid.get(String(p.cid))) || (p.sid && ph.bySid.get(String(p.sid))) || null : null);
  const phCol = classList.some(p => phOf(p)?.pre != null)
    ? [{ key: 'ph', label: 'Pahowdy', n: true, title: 'Pahowdy’s pre-draft score from his prospect database (shading = percentile vs. his prospects at the position since 2001). Only shown on your computer.', sort: p => phOf(p)?.pre, cell: p => { const r = phOf(p); return `<td class="n heat" style="${heat(r?.prePct)}">${r?.pre != null ? fmt1(r.pre) : '—'}</td>`; } }]
    : [];

  const mc = meta.mockConsensus?.year === st.cls ? meta.mockConsensus : null;
  const note = () => {
    const basis = `<b>Order</b> blends ${used.join(', ')}.`;
    if (status === 'watch') {
      return `<b>${st.cls} big board.</b> Every FBS QB, RB, WR and TE who can enter the ${st.cls} draft (three years out of high school: true juniors, redshirt sophomores, and players who returned to school), ranked for ${fmtName}. ${basis} `
        + (mc ? `<b>Mocks</b> = where the online NFL mocks have him (<a class="link" href="${esc(mc.url)}" target="_blank" rel="noopener">${esc(mc.source)}</a>): his pick in the first round of the latest ${mc.recentMocks || ''} mocks and how many of them have him there, or his season-long consensus rank if he isn’t a first-rounder in recent mocks. The latest mocks count three times as much as the season-long list, and they’re the biggest input to the order and to the projected NFL pick. ` : '')
        + '<b>Expert-style</b> = where FantasyPros experts would likely rank him, learned from how they ranked past classes before the draft; '
        + '<b>Buzz</b> = his Wikipedia page views vs. the class, the hype and draft buzz stats can’t see. '
        + `The Prospect Score adds <b>projected NFL draft capital</b> (from the online mocks, or for players they don’t list, a model trained on the ${drafts.length ? `${drafts[0]}–${drafts[drafts.length - 1]}` : 'recent'} drafts). Paste boards you trust below to blend them in. `
        + 'Real FantasyPros ranks and Sleeper ADP replace the projections automatically once they’re published; in March this becomes the combine class, and after the NFL Draft the drafted class.';
    }
    if (status === 'devy') {
      return `<b>${st.cls} devy board.</b> College players first eligible for the ${st.cls} draft (${st.cls - meta.upcoming === 1 ? 'true sophomores and redshirt freshmen' : 'true freshmen'} this fall) with real production or a 4–5★ recruiting profile, ranked for ${fmtName}. ${basis} `
        + 'Same models as the next class’s big board, with more uncertainty the further out the draft is: recruiting, early production, breakout age and Buzz carry the most weight. Paste devy rankings you trust below to blend them in.';
    }
    if (status === 'combine') return `<b>${st.cls} class — combine invitees.</b> Draft capital is added automatically after the NFL Draft. ${basis}`;
    return `<b>${st.cls} draft class.</b> ${basis}`;
  };

  const viewBtn = (v, label) => `<button data-v="${v}" class="${st.view === v ? 'on' : ''}">${label}</button>`;
  el.innerHTML = `
    <div class="page-head"><div>
      <h1>Rookies & prospects</h1>
      <p class="sub">A big board for the next draft class, plus Prospect Scores, consensus rankings, ADP and mock drafts for recent rookie classes.</p>
    </div></div>
    <div class="toolbar">
      <div class="seg" data-k="cls">${classes.map(c => `<button data-v="${c}" class="${c === st.cls ? 'on' : ''}">${c}${meta.classes[c].status !== 'drafted' ? ' ★' : ''}</button>`).join('')}</div>
      <div class="seg" data-k="view">${viewBtn('board', 'Big board')}${viewBtn('rankings', 'Rankings')}${viewBtn('mock', 'Mock draft')}</div>
      ${st.view !== 'mock'
        ? `<div class="seg" data-k="pos">${['ALL', 'QB', 'RB', 'WR', 'TE'].map(p => `<button data-v="${p}" class="${st.pos === p ? 'on' : ''}">${p === 'ALL' ? 'All' : p}</button>`).join('')}</div>
           <input type="search" placeholder="Search player or school" value="${esc(st.q)}" data-k="q">`
        : `<div class="seg" data-k="rounds">${[3, 4, 5].map(r => `<button data-v="${r}" class="${st.rounds === r ? 'on' : ''}">${r} rounds</button>`).join('')}</div>
           ${S.league ? `<div class="seg" data-k="mockSrc"><button data-v="league" class="${st.mockSrc === 'league' ? 'on' : ''}">My league</button><button data-v="generic" class="${st.mockSrc === 'generic' ? 'on' : ''}">Generic ${teams}-team</button></div>` : ''}`}
    </div>
    <p class="note">${note()}</p>
    <div data-body></div>
    <div class="more" data-more></div>`;

  const body = el.querySelector('[data-body]');
  const market = p => (p.sid ? S.rowById.get(p.sid)?.market || null : null);
  const adpOf = p => p.adp?.rookie ?? (sf ? p.adp?.dsf : p.adp?.d1qb) ?? null;
  const hasAdp = classList.some(p => adpOf(p) != null), hasEcr = classList.some(p => p.ecr);
  // pre-draft signals: expert-style projected rank and public attention (Wikipedia pageviews)
  const preCols = (sortable = false) => [
    ...(classList.some(p => p.mock) ? [{ key: 'mock2', label: 'Mocks', n: true, sort: sortable ? p => p.mock?.est ?? 99 : undefined,
      title: 'Online NFL mock drafts (Pro Football Network’s Mock Draft Index). The pick where he’s the most-mocked player in the latest mocks’ first round, and in how many of them; “season” = not a consensus first-rounder lately, so his season-long consensus rank. Hover for details',
      cell: x => { const p = x.p || x, m = p.mock; return `<td class="n" title="${esc(mockText(m))}">${!m ? '<span class="muted">—</span>' : m.recent != null ? `#${Math.round(m.recent)} <span class="muted small">${m.recentN}/${m.recentM}</span>` : `<span class="muted">#${m.rank} season</span>`}</td>`; } }] : []),
    ...(classList.some(p => p.xecr) ? [{ key: 'xecr', label: 'Expert-style', n: true, sort: sortable ? p => p.xecr : undefined,
      title: 'Where FantasyPros experts would likely rank him (1QB), from how they ranked past prospects with a similar profile before the draft. Replaced by the real expert ranking once FantasyPros ranks this class',
      cell: x => { const p = x.p || x; return `<td class="n">${p.ecr ? '<span class="muted">—</span>' : p.xecr ?? '—'}</td>`; } }] : []),
    ...(classList.some(p => p.buzz != null) ? [{ key: 'buzz', label: 'Buzz', n: true, sort: sortable ? p => p.buzz : undefined,
      title: 'Public attention: his Wikipedia page views over the last 60 days, as a percentile of the class (no article = low). Hype that scouting and expert rankings follow',
      cell: x => { const p = x.p || x; return `<td class="n heat" style="${heat(p.buzz)}">${p.buzz ?? '—'}</td>`; } }] : []),
  ];
  const filterQ = p => {
    const q = st.q.trim().toLowerCase();
    return (st.pos === 'ALL' || p.pos === st.pos) && (!q || nameMatch(p.name, q) || (p.school || '').toLowerCase().includes(q));
  };

  const boardsPanel = () => `
    <div class="card boards">
      <div class="bhead">
        <div>
          <h2 style="margin:0">Your boards</h2>
          <p class="muted small" style="margin:4px 0 0">Paste a ranking or mock draft from any site you read (KeepTradeCut, Draft Sharks, Dynasty Nerds, Dynasty League Football, Footballguys, RotoBaller, a r/DynastyFF post, any ${st.cls} mock) and say which format it’s for. One board for your format (${esc(fmtName)}) counts as much as the online mock consensus, and two or three count up to twice as much; boards for another format count half, adjusted to yours (a 1QB board’s QBs move up in superflex; a board without TE premium moves tight ends up when you use TE premium). Mark one as your base and the order starts from it (it counts about as much as everything else together), with the other signals still moving players. Each gets its own column; paste two or three and the board follows their consensus. These sites don’t allow apps to collect their rankings, so copy them yourself: they’re saved only in this browser.</p>
        </div>
        ${st.adding ? '' : '<button class="btn" data-act="addboard">+ Paste a board or mock</button>'}
      </div>
      ${st.adding ? `<div class="bform">
        <input type="text" data-k="bname" placeholder="Source (e.g. Footballguys)" maxlength="32">
        <div class="toolbar" style="margin:0"><select data-k="bqb" aria-label="QB format"><option value="">Any QB format</option><option value="1" ${sf ? '' : 'selected'}>1QB</option><option value="2" ${sf ? 'selected' : ''}>Superflex</option></select>
          <select data-k="btep" aria-label="TE premium"><option value="">No TE premium</option><option value="1" ${tep ? 'selected' : ''}>TE premium</option></select>
          <label class="small"><input type="checkbox" data-k="bbase"> Use as my base</label></div>
        <textarea data-k="btext" rows="8" placeholder="One player per line, best first. Rankings or mock drafts both work, e.g.&#10;1. Jeremiah Smith WR Ohio State&#10;2. Raiders — Julian Sayin, QB, Ohio State"></textarea>
        <div class="toolbar" style="margin:0"><button class="btn primary" data-act="saveboard">Add board</button><button class="btn" data-act="cancelboard">Cancel</button><span class="small" data-bmsg></span></div>
      </div>` : ''}
      ${st.msg ? `<p class="small" style="margin:8px 0 0">${st.msg}</p>` : ''}
      ${boards.length ? `<ul class="blist">${boards.map(b => `<li><b>${esc(b.name)}</b> <span class="muted small">${b.matched} matched · added ${esc(b.date)}</span>
        <select class="bfmt" data-bfmt="qb" data-id="${esc(b.id)}" aria-label="QB format of ${esc(b.name)}"><option value="">Any QB format</option><option value="1" ${b.qb === '1' ? 'selected' : ''}>1QB</option><option value="2" ${b.qb === '2' ? 'selected' : ''}>Superflex</option></select>
        <select class="bfmt" data-bfmt="tep" data-id="${esc(b.id)}" aria-label="TE premium of ${esc(b.name)}"><option value="">No TE premium</option><option value="1" ${b.tep ? 'selected' : ''}>TE premium</option></select>
        <label class="small" title="Your base board counts about as much as every other signal together"><input type="checkbox" class="bfmt" data-bfmt="base" data-id="${esc(b.id)}" ${b.base ? 'checked' : ''}> Base</label>
        <button class="linkbtn" data-act="rmboard" data-id="${esc(b.id)}">Remove</button>
        ${b.unmatched.length ? `<details class="small"><summary>${b.unmatched.length} line${b.unmatched.length === 1 ? '' : 's'} not matched to a ${st.cls} prospect</summary><div class="muted">${b.unmatched.slice(0, 40).map(esc).join('<br>')}</div></details>` : ''}</li>`).join('')}</ul>` : ''}
      <p class="muted small" style="margin:10px 0 0">Compare: ${OTHER_BOARDS.map(([n, u]) => `<a class="link" href="${typeof u === 'function' ? u(st.cls) : u}" target="_blank" rel="noopener">${n}</a>`).join(' · ')}</p>
    </div>`;

  const drawBoard = () => {
    const posN = new Map(), cnt = {};
    for (const x of board) posN.set(x.p, (cnt[x.p.pos] = (cnt[x.p.pos] || 0) + 1));
    const list = board.filter(x => filterQ(x.p));
    const cols = [
      { label: '#', n: true, cell: x => `<td class="rank">${x.rank}</td>` },
      { label: 'Player', cell: x => `<td>${playerCell(x.p)}</td>` },
      { label: 'Pos', title: 'Position rank on this board', cell: x => `<td>${posTag(x.p.pos)}<span class="small"> ${posN.get(x.p)}</span></td>` },
      ...(pre ? [
        { label: 'Year', title: 'College season this fall, counted from high school (3rd = true junior or redshirt sophomore)', cell: x => `<td>${x.p.yr ? ordinal(x.p.yr) : '—'}</td>` },
        { label: 'Eligible', title: `First NFL draft he can enter (three years out of high school). “Returned” = he could have entered an earlier draft and went back to school`, cell: x => `<td>${eligCell(x.p, st.cls)}</td>` },
        { label: 'Proj. NFL pick', n: true, title: 'Where he’d go in the NFL draft if he declares. For players the online mocks list: where they have him (latest mocks 3:1 over the season-long consensus). Otherwise our stats model (his rank at the position, mapped to where that many QBs/RBs/WRs/TEs have gone in the last 8 drafts), placed after the mocks’ top 40. Hover a pick for the details', cell: x => `<td class="n">${projCell(x.p)}</td>` },
        ...preCols(),
      ] : [
        { label: 'NFL draft', n: true, cell: x => `<td class="n">${x.p.draft ? `${x.p.draft.r}.${String(x.p.draft.p).padStart(2, '0')} <span class="muted small">${esc(x.p.draft.team)}</span>` : '—'}</td>` },
      ]),
      { label: 'Age', n: true, title: 'Age on draft day (~ = estimated from the high-school class)', cell: x => `<td class="n">${ageCell(x.p)}</td>` },
      { label: 'Score', n: true, title: 'Prospect Score (0–100)', cell: x => `<td class="n heat" style="${heat(x.p.score)}"><b>${x.p.score ?? '—'}</b></td>` },
      { label: 'Production', n: true, title: 'College production & efficiency percentile vs. prospects at the position', cell: x => `<td class="n heat" style="${heat(x.p.comps?.prod)}">${x.p.comps?.prod ?? '—'}</td>` },
      { label: 'Breakout', n: true, title: 'How early he became a featured producer (age, or class year)', cell: x => `<td class="n heat" style="${heat(x.p.comps?.brk)}">${x.p.comps?.brk ?? '—'}${brkNote(x.p)}</td>` },
      { label: 'Recruit', title: 'High-school recruiting stars (247 composite)', cell: x => `<td class="small" title="${x.p.recruit ? `Grade ${x.p.recruit.grade} (${x.p.recruit.year})` : ''}">${x.p.recruit ? stars(x.p.recruit.stars) : '—'}</td>` },
      ...(classList.some(p => p.pc) ? [{ label: 'Pro comp', title: COMP_TITLE, cell: x => compCell(x.p) }] : []),
      ...(hasEcr ? [{ label: 'Experts', n: true, title: 'FantasyPros dynasty rookie rankings (expert consensus rank)', cell: x => `<td class="n">${x.p.ecr ? fmt1(x.p.ecr.rank) : '—'}</td>` }] : []),
      ...(hasAdp ? [{ label: 'ADP', n: true, title: 'Sleeper ADP from real drafts', cell: x => `<td class="n">${adpOf(x.p) != null ? fmt1(adpOf(x.p)) : '—'}</td>` }] : []),
      ...boards.map(b => ({ label: esc(b.name), n: true, title: `Rank on your pasted ${b.name} board`, cell: x => `<td class="n">${b.rank(x.p) ?? '<span class="muted">—</span>'}</td>` })),
    ];
    const tierOf = r => (r <= teams * 4 ? Math.ceil(r / teams) : 5);
    const tierLabel = t => (t <= 4 ? `${ordinal(t)}-round rookie picks · ${(t - 1) * teams + 1}–${t * teams} in a ${teams}-team league` : 'Deeper prospects');
    let rowsHtml = '', last = null;
    for (const x of list.slice(0, st.limit)) {
      const t = tierOf(x.rank);
      if (t !== last) { rowsHtml += `<tr class="tierrow"><td colspan="${cols.length}"><span>${tierLabel(t)}</span></td></tr>`; last = t; }
      rowsHtml += `<tr>${cols.map(c => c.cell(x)).join('')}</tr>`;
    }
    const head = cols.map(c => `<th${c.n ? ' class="n"' : ''}${c.title ? ` title="${esc(c.title)}"` : ''}>${c.label}</th>`).join('');
    body.innerHTML = `${boardsPanel()}
      <div class="tablewrap tall" style="margin-top:12px"><table class="data pin"><thead><tr>${head}</tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="${cols.length}" class="empty">No players match.</td></tr>`}</tbody></table></div>`;
    el.querySelector('[data-more]').innerHTML = list.length > st.limit ? `<button class="btn" data-act="more">Show more (${list.length - st.limit} left)</button>` : `<span class="muted small">${list.length} prospects · shading = percentile (blue above average, red below)</span>`;
  };

  const drawRankings = () => {
    let list = classList.filter(filterQ);
    const cell = (v, extra = '') => `<td class="n heat" style="${heat(v)}">${v ?? '—'}${extra}</td>`;
    const cols = [
      { key: 'mock', label: 'Mock', n: true, title: 'Consensus mock-draft slot (see note above)', sort: p => mockRank.get(p), cell: p => `<td class="rank">${mockRank.get(p) ?? '—'}</td>` },
      { key: 'name', label: 'Player', sort: p => p.name, cell: p => `<td>${playerCell(p)}</td>` },
      { key: 'pos', label: 'Pos', sort: p => p.pos, cell: p => `<td>${posTag(p.pos)}</td>` },
      { key: 'school', label: 'School', sort: p => p.school, cell: p => `<td>${esc(p.school || '—')}</td>` },
      ...(!pre
        ? [{ key: 'draft', label: 'NFL draft', n: true, sort: p => p.draft?.p, cell: p => `<td class="n">${p.draft ? `${p.draft.r}.${String(p.draft.p).padStart(2, '0')} <span class="muted small">${esc(p.draft.team)}</span>` : '—'}</td>` }]
        : [
          { key: 'yr', label: 'Year', title: 'College season this fall, counted from high school', sort: p => p.yr, cell: p => `<td>${p.yr ? ordinal(p.yr) : '—'}</td>` },
          { key: 'elig', label: 'Eligible', n: true, title: 'First NFL draft he can enter (three years out of high school)', sort: p => p.elig, cell: p => `<td class="n">${eligCell(p, st.cls)}</td>` },
          { key: 'proj', label: 'Proj. pick', n: true, title: 'Projected NFL draft slot if he declares (model)', sort: p => p.proj?.pick ?? 999, cell: p => `<td class="n">${projCell(p)}</td>` },
          ...preCols(true),
        ]),
      ...(hasAdp ? [{ key: 'adp', label: 'ADP', n: true, title: 'Sleeper ADP from real drafts: rookie-draft ADP when available, otherwise dynasty startup ADP for this QB format', sort: p => adpOf(p), cell: p => `<td class="n">${adpOf(p) != null ? fmt1(adpOf(p)) : '—'}${p.adp?.rookie == null && adpOf(p) != null ? ' <span class="muted small">startup</span>' : ''}</td>` }] : []),
      ...(hasEcr ? [{ key: 'ecr', label: 'Experts', n: true, title: 'FantasyPros dynasty rookie rankings (expert consensus rank)', sort: p => p.ecr?.rank, cell: p => `<td class="n" title="${p.ecr ? `Best ${p.ecr.best}, worst ${p.ecr.worst} · ${p.ecr.date}` : ''}">${p.ecr ? fmt1(p.ecr.rank) : '—'}</td>` }] : []),
      { key: 'age', label: 'Age', n: true, title: 'Age on draft day (~ = estimated from the high-school class)', sort: p => p.age, cell: p => `<td class="n">${ageCell(p)}</td>` },
      { key: 'size', label: 'Ht / Wt', n: true, cell: p => `<td class="n">${p.ht ? `${Math.floor(p.ht / 12)}'${p.ht % 12}"` : '—'}${p.wt ? ` / ${p.wt}` : ''}</td>` },
      { key: 'forty', label: '40', n: true, title: '40-yard dash (combine)', sort: p => p.combine?.forty, cell: p => `<td class="n">${p.combine?.forty ?? '—'}</td>` },
      { key: 'rec', label: 'Recruit', title: 'High-school recruiting stars (247 composite grade)', sort: p => p.recruit?.grade, cell: p => `<td class="small" title="${p.recruit ? `Grade ${p.recruit.grade} (${p.recruit.year})` : ''}">${p.recruit ? stars(p.recruit.stars) : '—'}</td>` },
      { key: 'prod', label: 'Production', n: true, title: 'College production & efficiency percentile vs. prospects at the position', sort: p => p.comps?.prod, cell: p => cell(p.comps?.prod) },
      { key: 'brk', label: 'Breakout', n: true, title: 'How early they became a featured producer (by age when known, else class year)', sort: p => p.comps?.brk, cell: p => cell(p.comps?.brk, brkNote(p)) },
      { key: 'ath', label: 'Athletic', n: true, title: 'Combine athleticism percentile vs. all combine players at the position since 2000', sort: p => p.comps?.ath, cell: p => cell(p.comps?.ath) },
      ...(!pre
        ? [{ key: 'dc', label: 'Draft cap', n: true, title: 'Draft capital score from pick number', sort: p => p.comps?.dc, cell: p => cell(p.comps?.dc) }]
        : [{ key: 'pdc', label: 'Proj. DC', n: true, title: 'Projected draft capital: scored like real draft capital, from the projected pick (0 = projected undrafted)', sort: p => p.comps?.pdc, cell: p => cell(p.comps?.pdc) }]),
      { key: 'score', label: 'Score', n: true, title: 'Prospect Score (0–100)', sort: p => p.score, cell: p => `<td class="n heat" style="${heat(p.score)}"><b>${p.score ?? '—'}</b></td>` },
      ...(classList.some(p => p.pc) ? [{ key: 'pc', label: 'Pro comp', title: COMP_TITLE, cell: compCell }] : []),
      ...phCol,
      { key: 'mkt', label: 'Dynasty value', n: true, title: 'Current dynasty market value (once in the NFL)', sort: p => market(p), cell: p => `<td class="n">${market(p) ? fmtInt(market(p)) : '<span class="muted">—</span>'}</td>` },
    ];
    list = sortRows(list, cols, st.sort, st.dir);
    body.innerHTML = `<div class="tablewrap tall">${table({ cols, rows: list.slice(0, st.limit), sort: st.sort, dir: st.dir, cls: 'pin' })}</div>`;
    el.querySelector('[data-more]').innerHTML = list.length > st.limit ? `<button class="btn" data-act="more">Show more (${list.length - st.limit} left)</button>` : `<span class="muted small">${list.length} prospects · shading = percentile (blue above average, red below)</span>`;
  };

  const drawMock = async () => {
    body.innerHTML = '<div class="empty"><span class="spinner"></span> Running mock draft…</div>';
    el.querySelector('[data-more]').innerHTML = '';
    const useLeague = S.league && st.mockSrc === 'league';
    const { slots, source } = useLeague ? await leagueSlots(st.cls, st.rounds) : genericSlots(teams, st.rounds);
    const picks = runMock(board, slots);
    const rounds = [...new Set(picks.map(x => x.round))];
    const info = x => {
      if (!x) return '';
      const p = x.p, bits = [`consensus #${x.rank}`];
      if (p.adp?.rookie != null) bits.push(`ADP ${fmt1(p.adp.rookie)}`);
      if (p.ecr) bits.push(`experts #${fmt1(p.ecr.rank)}`);
      if (p.proj?.pick) bits.push(`proj. NFL #${p.proj.pick}`);
      if (p.score != null) bits.push(`score ${p.score}`);
      return bits.join(' · ');
    };
    body.innerHTML = `
      <p class="muted small" style="margin:0 0 10px">${useLeague ? `${esc(S.league.info.name)} · ` : ''}${esc(source)} · ${fmtName} · each team takes the best available player${useLeague ? ', nudged toward its two weakest positions' : ''}.${picks.some(x => x.me) ? ' Your picks are highlighted.' : ''}</p>
      <div class="grid2">${rounds.map(r => `
        <div class="card"><h2>Round ${r}</h2><div class="lineup">${picks.filter(x => x.round === r).map(x => `
          <div class="slot mockpick${x.me ? ' mine' : ''}">
            <span class="sl">${x.round}.${String(x.pick).padStart(2, '0')}</span>
            <div>${x.x ? playerCell(x.x.p) : '<span class="muted">—</span>'}
              <div class="muted small" style="margin-top:2px">${esc(x.team)}${x.via ? ` <span class="muted">(via ${esc(x.via)})</span>` : ''} · ${info(x.x)}</div></div>
            <span></span>
          </div>`).join('')}</div></div>`).join('')}
      </div>`;
  };

  const draw = () => (st.view === 'mock' ? drawMock() : st.view === 'board' ? drawBoard() : drawRankings());
  draw();

  el.addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (th) { const k = th.dataset.sort; st.dir = st.sort === k ? (st.dir === 'asc' ? 'desc' : 'asc') : ['mock', 'name', 'pos', 'school', 'yr', 'elig', 'proj', 'xecr', 'mock2', 'age', 'forty', 'draft', 'adp', 'ecr'].includes(k) ? 'asc' : 'desc'; st.sort = k; draw(); return; }
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'more') { st.limit += 150; draw(); return; }
      if (a === 'addboard') { st.adding = true; st.msg = ''; draw(); el.querySelector('[data-k="btext"]')?.focus(); return; }
      if (a === 'cancelboard') { st.adding = false; st.msg = ''; draw(); return; }
      if (a === 'saveboard') {
        const name = el.querySelector('[data-k="bname"]')?.value || '', text = el.querySelector('[data-k="btext"]')?.value || '';
        const r = addBoard(st.cls, name, text, classList, { qb: el.querySelector('[data-k="bqb"]')?.value || '', tep: el.querySelector('[data-k="btep"]')?.value === '1', base: !!el.querySelector('[data-k="bbase"]')?.checked });
        if (r.error) { el.querySelector('[data-bmsg]').innerHTML = `<span class="down">${esc(r.error)}</span>`; return; }
        st.adding = false;
        st.msg = `Added <b>${esc(r.board.name)}</b>: ${r.res.matched} players matched${r.res.unmatched.length ? `, ${r.res.unmatched.length} lines not matched` : ''}.${r.warning ? ` <span class="down">${esc(r.warning)}</span>` : ''}`;
        render(root, params, query);
        return;
      }
      if (a === 'rmboard') { removeBoard(st.cls, act.dataset.id); st.msg = ''; render(root, params, query); return; }
    }
    const b = e.target.closest('button');
    const seg = b?.closest('.seg');
    if (!seg?.dataset.k) return;
    const k = seg.dataset.k;
    if (k === 'cls') {
      st.cls = Number(b.dataset.v); st.sort = 'mock'; st.dir = 'asc'; st.limit = 150; st.adding = false; st.msg = '';
      location.hash = `#/prospects?class=${st.cls}${st.view === 'mock' ? '&view=mock' : ''}`;
      return;
    }
    if (k === 'view') { location.hash = `#/prospects?class=${st.cls}&view=${b.dataset.v}`; return; }
    st[k] = k === 'rounds' ? Number(b.dataset.v) : b.dataset.v;
    st.limit = 150;
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    draw();
  });
  el.addEventListener('input', e => { if (e.target.dataset.k === 'q') { st.q = e.target.value; st.limit = 150; draw(); } });
  // a saved board's format: re-rank with it
  el.addEventListener('change', e => {
    const f = e.target.dataset.bfmt;
    if (!f) return;
    updateBoard(st.cls, e.target.dataset.id, f === 'qb' ? { qb: e.target.value } : f === 'base' ? { base: e.target.checked } : { tep: e.target.value === '1' });
    st.msg = '';
    render(root, params, query);
  });
}

function playerCell(p) {
  const href = p.cid ? `#/college/player/${p.cid}` : p.sid ? `#/player/${p.sid}` : null;
  const src = p.sid ? `https://sleepercdn.com/content/nfl/players/thumb/${p.sid}.jpg` : p.cid ? collegeHeadshot(p.cid) : null;
  const img = src ? `<img class="hs" loading="lazy" width="30" height="30" style="width:30px;height:30px" src="${esc(src)}" alt="" onerror="this.style.visibility='hidden'">` : '<span class="hs" style="width:30px;height:30px;display:inline-block"></span>';
  const inner = `${img}<div><div class="nm">${esc(p.name)}</div><div class="meta">${posTag(p.pos)}<span>${esc(p.school || '')}</span></div></div>`;
  return href ? `<a class="pcell" href="${href}">${inner}</a>` : `<span class="pcell">${inner}</span>`;
}
