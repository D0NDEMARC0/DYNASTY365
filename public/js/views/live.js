// Live: box scores and fantasy points while NFL and college games are being played, refreshed automatically.
import { S, rows as valueRows, scoringLabel, scoringRules, sleeper, loadValues } from '../store.js';
import { SPORTS, SKILL, liveWeek, loadWeek, scorePlayer, statName, orderItems, isFlag, stTd, statLine, matchCollege, nflPlayerWeek } from '../live.js';
import { editCustomScoring, scoringSummary } from '../scoring.js';
import { loadProspects, loadCollegeSeason, collegeHeadshot } from '../college.js';
import { consensus } from '../mock.js';
import { userBoards } from '../boards.js';
import { esc, fmt1, posTag, injTag, headshot, nameMatch, tipRows } from '../ui.js';
import { mount, playerCell, isRookie } from './common.js';

const st = { sport: 'nfl', pos: 'ALL', scope: { nfl: 'all', cfb: 'board' }, q: '', game: null, gameFrom: null, sort: 'pts', dir: 'desc', limit: 100 };
// last points seen per player, so a refresh can show what changed (forgotten after 5 minutes away)
const prev = { nfl: { key: '', t: 0, pts: new Map() }, cfb: { key: '', t: 0, pts: new Map() } };
let session = 0;
const ORDER = { live: 0, pre: 1, final: 2 };
const IDLE = 5 * 60e3;

export const day = d => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' }) : '');
const clock = t => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
export const liveTag = '<span class="lv"><i></i>Live</span>';

/** Scoring for live points, NFL and college alike: your league's, your custom scoring, or the header's PPR / half / standard. */
export const scoringFor = () => scoringRules();

/** Kickers and team defenses count only in a linked league that starts them and scores them. */
const KDEF = { K: /^(fg|xp)/, DEF: /^(def_|pts_allow|sack$|int$|fum_rec$|safe$)/ };
function extras(sport) {
  if (sport !== 'nfl' || !S.league) return [];
  const sc = scoringRules();
  return ['K', 'DEF'].filter(p => S.league.slots.includes(p) && Object.keys(sc).some(k => sc[k] && KDEF[p].test(k)));
}

// ---------- fantasy points ----------
const num = v => { const x = Math.round(v * 100) / 100; return x < 0 ? `−${-x}` : String(x); };
/** Hover text: each stat that scored, what it's worth in this scoring, and the total. */
function pointsTip({ name, pts, items }) {
  const rows = orderItems(items).map(it => [isFlag(it.k, it.v) ? statName(it.k) : `${statName(it.k)} ${num(it.v)} × ${num(it.m)}`, num(it.pts)]);
  return tipRows(`${name}: ${num(pts)} pts`, rows.length ? rows : [['Nothing that scores yet', '0']], scoringLabel());
}

// ---------- box score columns ----------
const n = (s, k) => s[k] || 0;
const avg = (a, b) => (b ? (a / b).toFixed(1) : '0.0');
const DASH = '<span class="muted">–</span>';

// All games: one row per player, stats grouped passing, rushing, receiving (as in a fantasy box score)
const GROUPS = [
  { label: 'Passing', has: s => n(s, 'pass_att') > 0, cols: [
    { key: 'pass_cmp', label: 'C/ATT', title: 'Completions / attempts', v: s => `${n(s, 'pass_cmp')}/${n(s, 'pass_att')}`, sort: s => n(s, 'pass_cmp') },
    { key: 'pass_yd', label: 'YDS', title: 'Passing yards' },
    { key: 'pass_td', label: 'TD', title: 'Passing touchdowns' },
    { key: 'pass_int', label: 'INT', title: 'Interceptions thrown' },
  ] },
  { label: 'Rushing', has: s => n(s, 'rush_att') > 0, cols: [
    { key: 'rush_att', label: 'CAR', title: 'Carries' },
    { key: 'rush_yd', label: 'YDS', title: 'Rushing yards' },
    { key: 'rush_td', label: 'TD', title: 'Rushing touchdowns' },
  ] },
  { label: 'Receiving', has: s => n(s, 'rec_tgt') > 0 || n(s, 'rec') > 0, cols: [
    { key: 'rec', label: 'REC', title: 'Receptions' },
    { key: 'rec_tgt', label: 'TGT', title: 'Targets' },
    { key: 'rec_yd', label: 'YDS', title: 'Receiving yards' },
    { key: 'rec_td', label: 'TD', title: 'Receiving touchdowns' },
  ] },
  { label: 'Misc', misc: true, has: () => true, cols: [
    { key: 'fum_lost', label: 'FUM', title: 'Fumbles lost' },
    { key: 'two', label: '2PT', title: 'Two-point conversions (passing, rushing or receiving)', v: s => n(s, 'pass_2pt') + n(s, 'rush_2pt') + n(s, 'rec_2pt'), optional: true },
    { key: 'ret', label: 'RET TD', title: 'Kick and punt return touchdowns', v: s => stTd(s), optional: true },
  ] },
];
const colVal = (c, s) => (c.v ? c.v(s) : n(s, c.key));
const colSort = (c, s) => (c.sort ? c.sort(s) : colVal(c, s));
const STAT_COLS = GROUPS.flatMap(g => g.cols);

// One game: a section per kind of stat with a table per team (as on a game's box score page)
const SECTIONS = [
  { label: 'Passing', has: s => n(s, 'pass_att') > 0, order: s => n(s, 'pass_att') * 1e4 + n(s, 'pass_yd'), cols: [
    ['C/ATT', 'Completions / attempts', s => `${n(s, 'pass_cmp')}/${n(s, 'pass_att')}`],
    ['YDS', 'Passing yards', s => n(s, 'pass_yd')],
    ['AVG', 'Yards per pass attempt', s => avg(n(s, 'pass_yd'), n(s, 'pass_att'))],
    ['TD', 'Passing touchdowns', s => n(s, 'pass_td')],
    ['INT', 'Interceptions thrown', s => n(s, 'pass_int')],
    ['SACKS', 'Times sacked – yards lost', s => `${n(s, 'pass_sack')}-${n(s, 'pass_sack_yds')}`],
    ['RTG', 'Passer rating', s => (s.pass_rtg != null ? s.pass_rtg.toFixed(1) : '–')],
  ] },
  { label: 'Rushing', has: s => n(s, 'rush_att') > 0, order: s => n(s, 'rush_yd') * 1e3 + n(s, 'rush_att'), cols: [
    ['CAR', 'Carries', s => n(s, 'rush_att')],
    ['YDS', 'Rushing yards', s => n(s, 'rush_yd')],
    ['AVG', 'Yards per carry', s => avg(n(s, 'rush_yd'), n(s, 'rush_att'))],
    ['TD', 'Rushing touchdowns', s => n(s, 'rush_td')],
    ['LONG', 'Longest run', s => n(s, 'rush_lng')],
  ] },
  { label: 'Receiving', has: s => n(s, 'rec_tgt') > 0 || n(s, 'rec') > 0, order: s => n(s, 'rec_yd') * 1e4 + n(s, 'rec') * 100 + n(s, 'rec_tgt'), cols: [
    ['REC', 'Receptions', s => n(s, 'rec')],
    ['YDS', 'Receiving yards', s => n(s, 'rec_yd')],
    ['AVG', 'Yards per catch', s => avg(n(s, 'rec_yd'), n(s, 'rec'))],
    ['TD', 'Receiving touchdowns', s => n(s, 'rec_td')],
    ['LONG', 'Longest catch', s => n(s, 'rec_lng')],
    ['TGTS', 'Targets', s => n(s, 'rec_tgt')],
  ] },
  { label: 'Fumbles', optional: true, has: s => n(s, 'fum') > 0 || n(s, 'fum_lost') > 0, order: s => n(s, 'fum_lost') * 10 + n(s, 'fum'), cols: [
    ['FUM', 'Fumbles', s => n(s, 'fum')],
    ['LOST', 'Fumbles lost to the other team', s => n(s, 'fum_lost')],
  ] },
  { label: 'Kicking', pos: 'K', has: s => n(s, 'fga') > 0 || n(s, 'xpa') > 0, order: s => n(s, 'kick_pts'), cols: [
    ['FG', 'Field goals made / attempted', s => `${n(s, 'fgm')}/${n(s, 'fga')}`],
    ['LONG', 'Longest field goal', s => n(s, 'fgm_lng')],
    ['XP', 'Extra points made / attempted', s => `${n(s, 'xpm')}/${n(s, 'xpa')}`],
    ['PTS', 'Points scored', s => n(s, 'kick_pts')],
  ] },
  { label: 'Team defense', pos: 'DEF', has: () => true, order: () => 0, cols: [
    ['SACK', 'Sacks', s => n(s, 'sack')],
    ['INT', 'Interceptions', s => n(s, 'int')],
    ['FR', 'Fumble recoveries', s => n(s, 'fum_rec')],
    ['TD', 'Defensive and return touchdowns', s => n(s, 'def_td') + n(s, 'def_st_td')],
    ['SAFE', 'Safeties', s => n(s, 'safe')],
    ['PA', 'Points allowed', s => n(s, 'pts_allow')],
    ['YDS', 'Yards allowed', s => n(s, 'yds_allow')],
  ] },
];
const isPlayer = r => r.pos !== 'K' && r.pos !== 'DEF';

/** Your roster in the linked Sleeper league: { rid, players, starters } or null. */
function myRoster() {
  const L = S.league;
  if (!L || !S.sleeperUserId) return null;
  const r = L.rosters.find(x => x.owner_id === S.sleeperUserId || (x.co_owners || []).includes(S.sleeperUserId));
  return r ? { rid: r.roster_id, players: new Set(r.players || []), starters: new Set(r.starters || []) } : null;
}

// players this app knows for college matching, and the prospect board's order (as on the Prospects page)
let cctx = null;
async function collegeContext() {
  if (cctx && cctx.v === S.version) return cctx;
  const pdata = await loadProspects();
  const season = await loadCollegeSeason(pdata.meta.current).catch(() => ({ players: [] }));
  const pool = (season.players || []).map(s => ({ cid: String(s.cid), name: s.name, team: s.team, pos: s.pos }));
  const onBoard = pdata.prospects.filter(p => p.status !== 'drafted' && p.cid);
  for (const p of onBoard) pool.push({ cid: String(p.cid), name: p.name, team: p.school, pos: p.pos });
  const board = new Map(), sf = S.settings.qb === 2, history = pdata.prospects.filter(p => p.status === 'drafted');
  const classes = [...new Set(onBoard.map(p => p.draftClass))].sort((a, b) => a - b);
  for (const cls of classes) {
    const list = onBoard.filter(p => p.draftClass === cls);
    for (const x of consensus(list, { sf, history, boards: userBoards(cls, list), slots: pdata.meta.draftModel?.slots }).board) board.set(String(x.p.cid), { cls, rank: x.rank });
  }
  return (cctx = { v: S.version, pool, board, classes });
}

export async function render(root, params, query, rerender) {
  const el = mount(root);
  const my = ++session;
  const alive = () => my === session && el.isConnected;
  if ((query.sport === 'nfl' || query.sport === 'cfb') && query.sport !== st.sport) { st.sport = query.sport; st.game = null; }
  if (query.game && query.game !== st.gameFrom) { st.game = query.game; st.gameFrom = query.game; }
  const sport = st.sport, label = SPORTS[sport].label;
  valueRows();
  const mine = sport === 'nfl' ? myRoster() : null;
  if (st.scope.nfl === 'mine' && !mine) st.scope.nfl = 'all';
  const ex = extras(sport);
  if (!['ALL', ...SKILL, ...ex].includes(st.pos)) st.pos = 'ALL';

  el.innerHTML = `
    <div class="page-head"><div>
      <h1>Live games</h1>
      <p class="sub">Box scores and fantasy points while games are being played, updated automatically: NFL on Thursdays, Sundays and Mondays, college on Saturdays. Click a game for its full box score.</p>
    </div>
    <div class="seg" data-k="sport">${Object.entries(SPORTS).map(([k, v]) => `<button data-v="${k}" class="${k === sport ? 'on' : ''}">${v.label}</button>`).join('')}</div></div>
    <div class="livebar" data-bar><span><span class="spinner"></span> Loading this week’s ${label} games…</span></div>
    <div class="gstrip" data-games></div>
    <div data-matchup></div>
    <div data-scoring></div>
    <div class="toolbar" data-tools hidden></div>
    <div data-table></div>
    <div class="more" data-more></div>
    <p class="muted small">Live stats from <a class="link" href="https://docs.sleeper.com" target="_blank" rel="noopener">Sleeper</a> (Sportradar data), checked every ${SPORTS[sport].every / 1000} seconds while games are on. They can trail the broadcast by a minute and are sometimes corrected after the game. Hover a player’s points to see how they add up.${sport === 'cfb' ? ' College players link to their profiles when they match a player in this app’s college data.' : ''}</p>`;
  const $ = s => el.querySelector(s);

  let wk;
  try { wk = await liveWeek(sport); } catch (e) {
    $('[data-bar]').innerHTML = `<span>Couldn’t reach Sleeper for live games (${esc(e.message)}).</span>`;
    return;
  }
  if (!alive()) return;
  if (!wk.week) { $('[data-bar]').innerHTML = `<span>No ${label} games this week: the season is over or hasn’t started.</span>`; return; }
  const ctx = sport === 'cfb' ? await collegeContext().catch(() => null) : null;
  if (!alive()) return;

  let data = null, err = null, fresh = false, loading = false, timer = null, waiting = false, schools = new Map(), teamNames = new Map();

  const prepare = d => {
    const sc = scoringFor(), pv = prev[sport];
    const key = `${wk.season}|${wk.week}|${JSON.stringify(sc)}`;
    if (pv.key !== key || Date.now() - pv.t > IDLE) { pv.key = key; pv.pts = new Map(); }
    pv.t = Date.now();
    const m = sport === 'cfb' && ctx ? matchCollege(d.rows.filter(isPlayer), ctx.pool) : null;
    schools = m?.school || new Map();
    teamNames = new Map(d.rows.filter(r => r.pos === 'DEF').map(r => [r.team, r.name]));
    const byGame = new Map(d.games.map(g => [g.id, g]));
    for (const r of d.rows) {
      Object.assign(r, scorePlayer(r.stats, sc, r.pos));
      const before = pv.pts.get(r.id);
      r.delta = before == null ? 0 : r.pts - before;
      pv.pts.set(r.id, r.pts);
      r.game = byGame.get(r.gameId) || null;
      if (sport === 'nfl') {
        r.p = S.byId.get(r.id) || null;
        r.dyn = r.p ? S.rowById.get(r.p.id) || null : null;
      } else {
        r.cid = m?.ids.get(r.id) || null;
        r.board = r.cid ? ctx.board.get(r.cid) || null : null;
      }
    }
    if (st.game && !byGame.has(st.game)) st.game = null;
  };

  const refresh = async () => {
    if (loading) return;
    loading = true;
    const btn = $('[data-act="refresh"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Updating'; }
    try {
      const d = await loadWeek(sport, wk);
      if (!alive()) return;
      prepare(d);
      data = d; err = null; fresh = true;
    } catch (e) { err = e.message; }
    finally { loading = false; }
    if (!alive()) return;
    draw();
    fresh = false;
    drawMatchup();
  };

  // every 30-60 seconds while a game is on, every 5 minutes otherwise (to catch kickoffs); paused in a hidden tab
  const plan = () => {
    clearTimeout(timer);
    if (!alive()) return;
    timer = setTimeout(tick, data?.live || err ? SPORTS[sport].every : IDLE);
  };
  const tick = async () => {
    if (!alive()) return;
    if (document.hidden) { waiting = true; return; }
    await refresh();
    plan();
  };
  const onVis = () => {
    if (!alive()) { document.removeEventListener('visibilitychange', onVis); return; }
    if (!document.hidden && waiting) { waiting = false; tick(); }
  };
  document.addEventListener('visibilitychange', onVis);

  // ---------- drawing ----------
  const schoolOf = abbr => schools.get(abbr) || '';
  const teamName = t => (sport === 'nfl' ? teamNames.get(t) : schoolOf(t)) || t;
  const drawBar = () => {
    const g = data?.games || [];
    const c = s => g.filter(x => x.state === s).length;
    const parts = [`Week ${wk.week}${wk.type === 'post' ? ' (postseason)' : ''}`];
    if (c('live')) parts.push(`<span class="lv"><i></i>${c('live')} live</span>`);
    if (c('final')) parts.push(`${c('final')} final`);
    if (c('pre')) parts.push(`${c('pre')} still to play`);
    const when = data ? `Updated ${clock(data.fetched)} · ${data.live ? `updates every ${SPORTS[sport].every / 1000} s` : 'checks for kickoffs every 5 min'}` : '';
    $('[data-bar]').innerHTML = `<span>${parts.join(' · ')}</span><span class="muted small">${when}${err ? ` · <span class="down">couldn’t update (${esc(err)}); trying again</span>` : ''}</span>
      <button class="btn" data-act="refresh">Refresh</button>`;
  };

  const chip = g => {
    const scored = g.hs != null;
    const win = scored && g.state === 'final' ? (g.as > g.hs ? 'a' : g.hs > g.as ? 'h' : '') : '';
    const team = (t, s, w) => `<span class="gt${w ? ' w' : ''}"><span>${esc(t || '?')}</span>${scored ? `<b>${s}</b>` : ''}</span>`;
    const status = g.state === 'live' ? liveTag : g.state === 'final' ? 'Final' : esc(day(g.date));
    return `<button class="gchip ${g.state}${st.game === g.id ? ' on' : ''}" data-game="${esc(g.id)}" title="${esc(`${teamName(g.away)} ${g.vs ? 'vs' : 'at'} ${teamName(g.home)}`)}">${team(g.away, g.as, win === 'a')}${team(g.home, g.hs, win === 'h')}<span class="gs">${status}</span></button>`;
  };
  const drawGames = () => {
    const tracked = new Map();
    if (sport === 'cfb') for (const r of data.rows) if (r.board) tracked.set(r.gameId, (tracked.get(r.gameId) || 0) + 1);
    const g = [...data.games].sort((a, b) => ORDER[a.state] - ORDER[b.state] || (tracked.get(b.id) || 0) - (tracked.get(a.id) || 0)
      || String(a.date).localeCompare(String(b.date)) || String(a.away).localeCompare(String(b.away)));
    $('[data-games]').innerHTML = g.map(chip).join('');
  };

  const drawScoring = () => {
    const sc = scoringFor(), custom = S.settings.scoring === 'custom' && S.settings.custom;
    const name = scoringLabel().replace(/ · TE \+[\d.]+$/, ''); // the TE premium is in the rules
    const src = S.settings.scoring === 'league' && S.league ? `${name} (${esc(S.league.info.name)})` : esc(name);
    const firstDowns = sport === 'cfb' && ['pass_fd', 'rush_fd', 'rec_fd', 'bonus_fd_qb', 'bonus_fd_rb', 'bonus_fd_wr', 'bonus_fd_te'].some(k => sc[k]);
    const notes = [
      !S.league ? `<a class="link" href="#/league">Link your Sleeper league</a> to use its exact scoring${custom ? '' : ', or set your own'}. TE premium is in the menu at the top.` : '',
      firstDowns ? 'College stats don’t include first downs, so first-down points don’t count here.' : '',
    ].filter(Boolean).join(' ');
    $('[data-scoring]').innerHTML = `<div class="scorebar"><span><b>Fantasy points:</b> ${src}</span>
      <span class="rules">${scoringSummary(sc).map(esc).join(' · ')}</span>
      <button class="btn" data-act="scoring">${custom ? 'Edit custom scoring' : 'Custom scoring'}</button>
      ${notes ? `<span class="muted note2">${notes}</span>` : ''}</div>`;
  };

  const scopes = () => (sport === 'nfl'
    ? [['all', 'All players'], ...(mine ? [['mine', 'My team (Sleeper)']] : []), ['rookies', 'Rookies']]
    : [['board', 'On the prospect board'], ...(ctx?.classes || []).map(c => [`c${c}`, `${c} draft class`]), ['all', 'All players']]);
  const drawTools = () => {
    const t = $('[data-tools]');
    t.hidden = false;
    t.innerHTML = `
      <div class="seg" data-k="pos">${['ALL', ...SKILL, ...ex].map(p => `<button data-v="${p}" class="${st.pos === p ? 'on' : ''}">${p === 'ALL' ? 'All' : p}</button>`).join('')}</div>
      <select data-k="scope" aria-label="Which players" ${st.game ? 'disabled title="A game’s box score shows everyone in it"' : ''}>${scopes().map(([v, l]) => `<option value="${v}" ${v === st.scope[sport] ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <input type="search" placeholder="Search player or team" value="${esc(st.q)}" data-k="q">`;
  };

  const posOk = r => st.pos === 'ALL' || r.pos === st.pos || (st.pos === 'RB' && r.pos === 'FB');
  const visible = () => {
    const sc = st.scope[sport];
    let list = data.rows.filter(r => (isPlayer(r) || ex.includes(r.pos)) && posOk(r));
    // one game: everyone in it; otherwise the chosen group
    if (st.game) list = list.filter(r => r.gameId === st.game);
    else if (sc === 'mine' && mine) list = list.filter(r => mine.players.has(r.id));
    else if (sc === 'rookies') list = list.filter(r => r.p && isRookie(r.p));
    else if (sc === 'board') list = list.filter(r => r.board);
    else if (/^c\d+$/.test(sc)) list = list.filter(r => r.board?.cls === Number(sc.slice(1)));
    // an active player with no stat yet is listed only on your own roster
    if (st.game || sc !== 'mine') list = list.filter(r => r.played);
    const q = st.q.trim();
    if (q) {
      const ql = q.toLowerCase();
      list = list.filter(r => nameMatch(r.name, q) || [r.team, teamName(r.team)].some(t => t && t.toLowerCase().startsWith(ql)));
    }
    return list;
  };

  const role = r => (mine?.players.has(r.id) ? `<span class="tag rk" title="On your Sleeper roster">${mine.starters.has(r.id) ? 'Starter' : 'Bench'}</span>` : '');
  const who = (r, size = 28, withTeam = true) => {
    const team = withTeam ? `<span>${esc(r.team)}</span>` : '';
    if (r.pos === 'DEF') {
      return `<span class="pcell">${headshot({ hs: `https://sleepercdn.com/images/team_logos/nfl/${String(r.team).toLowerCase()}.png` }, size)}<div><div class="nm">${esc(r.name)}</div><div class="meta">${posTag('DEF')}${role(r)}</div></div></span>`;
    }
    if (sport === 'nfl') {
      if (r.p) return playerCell(r.p, { size, sub: `${posTag(r.p.pos)}${withTeam ? `<span>${esc(r.p.team || r.team)}</span>` : ''}${isRookie(r.p) ? '<span class="tag rk" title="Rookie">R</span>' : ''}${injTag(r.p.inj)}${role(r)}` });
      return `<span class="pcell">${headshot({ sid: r.id }, size)}<div><div class="nm">${esc(r.name)}</div><div class="meta">${posTag(r.pos)}${team}${role(r)}</div></div></span>`;
    }
    const meta = `${posTag(r.pos)}${withTeam ? `<span title="${esc(schoolOf(r.team))}">${esc(r.team)}</span>` : ''}`;
    if (!r.cid) return `<span class="pcell"><span class="hs" style="width:${size}px;height:${size}px;display:inline-block"></span><div><div class="nm">${esc(r.name)}</div><div class="meta">${meta}</div></div></span>`;
    return `<a class="pcell" href="#/college/player/${esc(r.cid)}"><img class="hs" loading="lazy" width="${size}" height="${size}" style="width:${size}px;height:${size}px" src="${esc(collegeHeadshot(r.cid))}" alt="" onerror="this.style.visibility='hidden'"><div><div class="nm">${esc(r.name)}</div><div class="meta">${meta}</div></div></a>`;
  };
  const gameCell = r => {
    const g = r.game;
    if (!g) return `vs ${esc(r.opp || '?')}`;
    const home = g.vs || r.team === g.home;
    const score = g.hs != null ? ` · ${home ? g.hs : g.as}–${home ? g.as : g.hs}` : '';
    const status = g.state === 'live' ? liveTag : g.state === 'final' ? '<span class="muted">Final</span>' : '';
    return `${home ? 'vs' : '@'} ${esc(r.opp)}${score} ${status}`;
  };
  const ptsCell = r => {
    const d = Math.abs(r.delta) >= 0.05 ? ` <span class="dpts ${r.delta > 0 ? 'up' : 'down'}" title="Since the last update">${r.delta > 0 ? '+' : '−'}${fmt1(Math.abs(r.delta))}</span>` : '';
    return `<span class="fpts" data-tip="${pointsTip(r)}">${fmt1(r.pts)}</span>${d}`;
  };
  const rowCls = r => [fresh && Math.abs(r.delta) >= 0.05 ? 'bump' : '', sport === 'nfl' && (st.game || st.scope.nfl !== 'mine') && mine?.players.has(r.id) ? 'me' : ''].filter(Boolean).join(' ');
  const fptsTitle = `Fantasy points (${scoringLabel()}) from all of his stats. Hover a number to see how it adds up.`;

  // ----- all games: one fantasy box score row per player -----
  const TAIL = sport === 'nfl'
    ? [{ key: 'val', label: 'Dynasty', title: 'Dynasty market rank at his position (FantasyCalc)', sort: r => r.dyn?.market || null, cell: r => `<td class="n">${r.dyn?.mktPosRank ? `${r.pos}${r.dyn.mktPosRank}` : DASH}</td>` }]
    : [{ key: 'board', label: 'Board', title: 'Rank on the prospect board (Prospects tab) and draft class', sort: r => (r.board ? r.board.cls * 10000 + r.board.rank : null), cell: r => `<td class="n">${r.board ? `#${r.board.rank} <span class="muted">’${String(r.board.cls).slice(2)}</span>` : DASH}</td>` }];
  const sorters = {
    pts: r => r.pts, name: r => r.name, game: r => ORDER[r.game?.state] ?? 3,
    ...Object.fromEntries(STAT_COLS.map(c => [c.key, r => colSort(c, r.stats)])),
    ...Object.fromEntries(TAIL.map(t => [t.key, t.sort])),
  };
  const sortList = list => {
    if (!sorters[st.sort]) { st.sort = 'pts'; st.dir = 'desc'; }
    const f = sorters[st.sort], m = st.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = f(a), vb = f(b);
      if (va == null || vb == null) return va == null && vb == null ? 0 : va == null ? 1 : -1;
      return (typeof va === 'string' ? m * va.localeCompare(vb) : m * (va - vb)) || b.pts - a.pts;
    });
  };
  const sortCls = k => (k === st.sort ? ` sorted${st.dir === 'asc' ? ' asc' : ''}` : '');
  const boxTable = rows => {
    const groups = GROUPS
      .map(g => ({ ...g, cols: g.cols.filter(c => !c.optional || rows.some(r => colVal(c, r.stats))) }))
      .filter(g => g.misc || !rows.length || rows.some(r => g.has(r.stats)));
    const top = `<th rowspan="2">#</th><th rowspan="2" class="pc${sortCls('name')}" data-sort="name">Player</th><th rowspan="2" class="${sortCls('game')}" data-sort="game">Game</th>`
      + groups.map(g => `<th colspan="${g.cols.length}" class="grp">${g.label}</th>`).join('')
      + `<th rowspan="2" class="n fp${sortCls('pts')}" data-sort="pts" title="${esc(fptsTitle)}">FPTS</th>`
      + TAIL.map(t => `<th rowspan="2" class="n${sortCls(t.key)}" data-sort="${t.key}" title="${esc(t.title)}">${t.label}</th>`).join('');
    const sub = groups.flatMap(g => g.cols.map((c, i) => `<th class="n${i ? '' : ' g0'}${sortCls(c.key)}" data-sort="${c.key}" title="${esc(c.title)}">${c.label}</th>`)).join('');
    const cell = (g, c, r, first) => {
      const v = colVal(c, r.stats);
      return `<td class="n${first ? ' g0' : ''}">${(g.misc ? v : g.has(r.stats)) ? v : DASH}</td>`;
    };
    const body = rows.map((r, i) => `<tr class="${rowCls(r)}"><td class="rank">${i + 1}</td><td class="pc">${who(r)}</td><td class="small">${gameCell(r)}</td>`
      + groups.map(g => g.cols.map((c, j) => cell(g, c, r, !j)).join('')).join('')
      + `<td class="n fp">${ptsCell(r)}</td>${TAIL.map(t => t.cell(r)).join('')}</tr>`).join('');
    return `<div class="tablewrap"><table class="data box"><thead><tr>${top}</tr><tr>${sub}</tr></thead><tbody>${body || '<tr><td colspan="30" class="empty">No players match.</td></tr>'}</tbody></table></div>`;
  };
  // kickers and team defenses, when your league starts them
  const extraTable = (sec, rows) => {
    rows = [...rows].sort((a, b) => b.pts - a.pts);
    return `<h3 class="bxh">${sec.label}</h3><div class="tablewrap"><table class="data box"><thead><tr><th class="pc">${sec.pos === 'DEF' ? 'Team' : 'Player'}</th><th>Game</th>`
      + sec.cols.map(([l, t], i) => `<th class="n${i ? '' : ' g0'}" title="${esc(t)}">${l}</th>`).join('') + `<th class="n fp" title="${esc(fptsTitle)}">FPTS</th></tr></thead><tbody>`
      + rows.map(r => `<tr class="${rowCls(r)}"><td class="pc">${who(r)}</td><td class="small">${gameCell(r)}</td>${sec.cols.map(([, , v], i) => `<td class="n${i ? '' : ' g0'}">${sec.has(r.stats) ? v(r.stats) : DASH}</td>`).join('')}<td class="n fp">${ptsCell(r)}</td></tr>`).join('')
      + '</tbody></table></div>';
  };

  // ----- one game: box score by section and team -----
  const boxHead = g => {
    const scored = g.hs != null;
    const lose = t => (scored && g.state === 'final' && (t === 'a' ? g.as < g.hs : g.hs < g.as) ? ' lose' : '');
    const status = g.state === 'live' ? liveTag : g.state === 'final' ? 'Final' : esc(day(g.date));
    const nm = t => (teamName(t) !== t ? `<span class="nm">${esc(teamName(t))}</span>` : '');
    return `<div class="card boxhead">
      <div class="bt${lose('a')}"><span class="ab">${esc(g.away)}</span>${nm(g.away)}${scored ? `<b>${g.as}</b>` : ''}</div>
      <div class="bst">${g.vs ? 'vs' : '@'} · ${status}</div>
      <div class="bt${lose('h')}">${scored ? `<b>${g.hs}</b>` : ''}${nm(g.home)}<span class="ab">${esc(g.home)}</span></div>
      <button class="linkbtn" data-act="allgames">← All games</button></div>`;
  };
  const teamTable = (sec, team, rows) => {
    rows = [...rows].sort((a, b) => sec.order(b.stats) - sec.order(a.stats) || b.pts - a.pts);
    const head = `<tr><th class="pc tn">${esc(teamName(team))}</th>${sec.cols.map(([l, t]) => `<th class="n" title="${esc(t)}">${l}</th>`).join('')}<th class="n fp" title="${esc(fptsTitle)}">FPTS</th></tr>`;
    const body = rows.map(r => `<tr class="${rowCls(r)}"><td class="pc">${who(r, 24, false)}</td>${sec.cols.map(([, , v]) => `<td class="n">${v(r.stats)}</td>`).join('')}<td class="n fp">${ptsCell(r)}</td></tr>`).join('')
      || `<tr><td class="muted small" colspan="${sec.cols.length + 2}">No ${sec.label.toLowerCase()} yet</td></tr>`;
    return `<div class="tablewrap"><table class="data box bxt"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  };
  const gameBox = (g, list) => {
    const filtered = st.pos !== 'ALL' || st.q.trim();
    const out = [];
    for (const sec of SECTIONS) {
      if (sec.pos && !ex.includes(sec.pos)) continue;
      const rows = list.filter(r => (sec.pos ? r.pos === sec.pos : isPlayer(r)) && sec.has(r.stats));
      if (!rows.length && (sec.optional || sec.pos || filtered)) continue;
      out.push(`<section class="bx"><h3>${sec.label}</h3><div class="bxgrid">${[g.away, g.home].map(t => teamTable(sec, t, rows.filter(r => r.team === t))).join('')}</div></section>`);
    }
    return out.join('') || '<div class="empty">No stats for these players in this game yet.</div>';
  };

  const drawBox = () => {
    const box = $('[data-table]'), more = $('[data-more]');
    if (!data) {
      box.innerHTML = `<div class="tablewrap"><div class="empty">${err ? `Couldn’t load live stats from Sleeper (${esc(err)}). Trying again shortly.` : '<span class="spinner"></span>'}</div></div>`;
      return;
    }
    if (!data.rows.some(r => r.played)) {
      const next = data.games.filter(x => x.state === 'pre').sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
      box.innerHTML = `<div class="tablewrap"><div class="empty">No ${label} game has kicked off yet this week${next ? ` · next up ${esc(day(next.date))}` : ''}.</div></div>`;
      more.innerHTML = '';
      return;
    }
    const list = visible(), pl = list.length === 1 ? '' : 's';
    const g = st.game ? data.games.find(x => x.id === st.game) : null;
    if (g) {
      const started = data.rows.some(r => r.gameId === g.id && r.played);
      box.innerHTML = boxHead(g) + (started ? gameBox(g, list) : `<div class="empty">This game hasn’t kicked off yet${g.date ? ` (${esc(day(g.date))})` : ''}. Its box score fills in once it starts.</div>`);
      more.innerHTML = `<span class="muted small">${list.length} player${pl} with a stat in this game · points: ${esc(scoringLabel())}</span>`;
      return;
    }
    const players = sortList(list.filter(isPlayer));
    let html = players.length || !list.length ? boxTable(players.slice(0, st.limit)) : '';
    for (const sec of SECTIONS.filter(s => s.pos && ex.includes(s.pos))) {
      const rows = list.filter(r => r.pos === sec.pos);
      if (rows.length) html += extraTable(sec, rows);
    }
    box.innerHTML = html;
    const scopeEmpty = !list.length && !st.q && st.pos === 'ALL';
    more.innerHTML = players.length > st.limit ? `<button class="btn" data-act="more">Show more (${players.length - st.limit} left)</button>`
      : scopeEmpty ? '<span class="muted small">None of these players has played yet this week.</span>'
        : `<span class="muted small">${list.length} player${pl} this week · points: ${esc(scoringLabel())}${sport === 'nfl' && mine && st.scope.nfl !== 'mine' ? ' · highlighted: your Sleeper roster' : ''}</span>`;
  };

  const draw = () => {
    if (!alive()) return;
    drawBar();
    if (data) { drawGames(); if ($('[data-tools]').hidden) { drawTools(); drawScoring(); } }
    drawBox();
  };

  // your Sleeper matchup this week, scored by Sleeper with your league's settings
  const drawMatchup = async () => {
    if (sport !== 'nfl' || !mine || !S.leagueId) return;
    let ms;
    try { ms = await sleeper(`/league/${S.leagueId}/matchups/${wk.week}`); } catch { return; }
    const me = ms?.find(m => m.roster_id === mine.rid);
    if (!alive() || !me || me.matchup_id == null) return;
    const opp = ms.find(m => m.matchup_id === me.matchup_id && m.roster_id !== me.roster_id);
    const nameOf = rid => {
      const ro = S.league.rosters.find(r => r.roster_id === rid);
      const u = S.league.users.find(x => x.user_id === ro?.owner_id);
      return u?.metadata?.team_name || u?.display_name || `Team ${rid}`;
    };
    const side = (m, cls) => `<div class="mside ${cls}"><div class="mname">${esc(nameOf(m.roster_id))}</div><div class="mpts">${fmt1(m.points || 0)}</div></div>`;
    $('[data-matchup]').innerHTML = `<div class="card matchup">
      <div class="mhead"><h2 style="margin:0">Your matchup · week ${wk.week}</h2><button class="linkbtn" data-act="mine">Show my players</button></div>
      <div class="mrow">${side(me, (me.points || 0) >= (opp?.points || 0) ? 'lead' : '')}<span class="muted">vs</span>${opp ? side(opp, (opp.points || 0) > (me.points || 0) ? 'lead' : '') : '<div class="mside"><div class="mname muted">No opponent</div></div>'}</div>
      <p class="muted small" style="margin:6px 0 0">${esc(S.league.info.name)} · points from Sleeper with your league’s scoring, starters only</p></div>`;
  };

  // ---------- events ----------
  const showGame = id => { st.game = id; st.limit = 100; drawTools(); drawGames(); drawBox(); };
  el.addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      st.dir = st.sort === k ? (st.dir === 'asc' ? 'desc' : 'asc') : ['name', 'board', 'game'].includes(k) ? 'asc' : 'desc';
      st.sort = k; drawBox(); return;
    }
    const chipEl = e.target.closest('[data-game]');
    if (chipEl) { showGame(st.game === chipEl.dataset.game ? null : chipEl.dataset.game); return; }
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'refresh') { clearTimeout(timer); refresh().then(plan); return; }
    if (act === 'more') { st.limit += 100; drawBox(); return; }
    if (act === 'allgames') { showGame(null); return; }
    if (act === 'mine') { st.scope.nfl = 'mine'; showGame(null); return; }
    if (act === 'scoring') {
      editCustomScoring().then(async saved => {
        if (!saved) return;
        await loadValues().catch(() => {});
        if (rerender) rerender();
      });
      return;
    }
    const seg = b.closest('.seg');
    if (seg?.dataset.k === 'sport' && b.dataset.v !== sport) { location.hash = `#/live?sport=${b.dataset.v}`; return; }
    if (seg?.dataset.k === 'pos') {
      st.pos = b.dataset.v; st.limit = 100;
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      drawBox();
    }
  });
  el.addEventListener('change', e => { if (e.target.dataset.k === 'scope') { st.scope[sport] = e.target.value; st.limit = 100; showGame(null); } });
  el.addEventListener('input', e => { if (e.target.dataset.k === 'q') { st.q = e.target.value; st.limit = 100; drawBox(); } });

  await refresh();
  plan();
}

// ---------- "this week" lines on player pages (refreshed every minute while his game is on) ----------
function strip(box, { week, state, opp, date, line, score, name, href }) {
  const status = state === 'live' ? liveTag : state === 'final' ? '<span class="muted">Final</span>' : `<span class="muted">${esc(day(date))}</span>`;
  box.innerHTML = `<div class="card livestrip"><b>Week ${week}</b><span>${esc(opp)}</span>${status}
    ${line != null ? `<span>${esc(line) || 'no stats yet'}</span><span class="fpts" data-tip="${pointsTip({ name, ...score })}"><b>${fmt1(score.pts)}</b> ${esc(scoringLabel())} pts</span>` : '<span class="muted">no stats yet</span>'}
    <a class="link" href="${href}">Box score →</a></div>`;
}
const repeat = (box, fn) => {
  const tick = async () => {
    if (!box.isConnected) return;
    let again = false;
    try { again = await fn(); } catch { /* Sleeper unreachable: leave the page as it is */ }
    if (again && box.isConnected) setTimeout(() => (document.hidden ? setTimeout(tick, 60e3) : tick()), 60e3);
  };
  tick();
};

/** NFL player page: his game this week (from the schedule) and his line once it starts. */
export function nflStrip(box, p) {
  if (!box || !p?.sid || !SKILL.includes(p.pos)) return;
  repeat(box, async () => {
    const w = await nflPlayerWeek(p.sid);
    if (!w || !box.isConnected) return false;
    const g = w.games.find(x => x.home === p.team || x.away === p.team) || null;
    const row = w.row?.stats ? w.row : null;
    if (!g && !row) { box.innerHTML = ''; return false; }
    const state = g?.status === 'complete' ? 'final' : row || g?.status === 'in_game' ? 'live' : 'pre';
    const opp = g ? (g.home === p.team ? `vs ${g.away}` : `@ ${g.home}`) : `vs ${row.opponent || '?'}`;
    strip(box, {
      week: w.week, state, opp, date: g?.date, line: row ? statLine(row.stats, p.pos) : null, name: p.name,
      score: row ? scorePlayer(row.stats, scoringFor(), p.pos) : null, href: `#/live?sport=nfl${g ? `&game=${encodeURIComponent(g.game_id)}` : ''}`,
    });
    return state === 'live';
  });
}

/** College player page: his line this week once his game has started (matched to Sleeper by name and school). */
export function collegeStrip(box, { cid, name, pos, team }) {
  if (!box || !SKILL.includes(pos)) return;
  repeat(box, async () => {
    const w = await liveWeek('cfb');
    if (!w.week) return false;
    const [d, pdata] = await Promise.all([loadWeek('cfb', w, { fresh: false }), loadProspects()]);
    if (!box.isConnected) return false;
    const pool = pdata.prospects.filter(p => p.status !== 'drafted' && p.cid).map(p => ({ cid: String(p.cid), name: p.name, team: p.school, pos: p.pos }));
    pool.push({ cid: String(cid), name, team, pos });
    const { ids } = matchCollege(d.rows, pool);
    const row = d.rows.find(r => ids.get(r.id) === String(cid) && r.played);
    if (!row) { box.innerHTML = ''; return false; }
    const g = d.games.find(x => x.id === row.gameId);
    const home = !g || g.vs || g.home === row.team;
    strip(box, {
      week: w.week, state: g?.state || 'live', opp: `${home ? 'vs' : '@'} ${row.opp}`, date: g?.date, line: statLine(row.stats, pos), name,
      score: scorePlayer(row.stats, scoringFor(), pos), href: `#/live?sport=cfb&game=${encodeURIComponent(row.gameId)}`,
    });
    return g?.state === 'live';
  });
}
