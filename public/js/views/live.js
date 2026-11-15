// Live: box scores and fantasy points while NFL and college games are being played, refreshed automatically.
import { S, rows as valueRows, scoringLabel, pprParam, sleeper } from '../store.js';
import { PRESETS } from '../model.js';
import { SPORTS, SKILL, liveWeek, loadWeek, livePoints, statLine, matchCollege, nflPlayerWeek } from '../live.js';
import { loadProspects, loadCollegeSeason, collegeHeadshot } from '../college.js';
import { consensus } from '../mock.js';
import { userBoards } from '../boards.js';
import { esc, fmt1, posTag, injTag, headshot, table, sortRows, nameMatch } from '../ui.js';
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

/** Scoring for live points: your league's (NFL, when linked) or the PPR / half / standard choice in the header. */
export function scoringFor(sport) {
  if (sport === 'nfl' && S.settings.scoring === 'league' && S.league) return S.league.scoring;
  const p = pprParam();
  return PRESETS[p >= 0.75 ? 'ppr' : p >= 0.25 ? 'half' : 'std'];
}
const ptsLabel = sport => (sport === 'cfb' && S.settings.scoring === 'league' ? { 1: 'PPR', 0.5: 'Half PPR', 0: 'Standard' }[pprParam()] : scoringLabel());

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
    for (const x of consensus(list, { sf, history, boards: userBoards(cls, list) }).board) board.set(String(x.p.cid), { cls, rank: x.rank });
  }
  return (cctx = { v: S.version, pool, board, classes });
}

export async function render(root, params, query) {
  const el = mount(root);
  const my = ++session;
  const alive = () => my === session && el.isConnected;
  if ((query.sport === 'nfl' || query.sport === 'cfb') && query.sport !== st.sport) { st.sport = query.sport; st.game = null; }
  if (query.game && query.game !== st.gameFrom) { st.game = query.game; st.gameFrom = query.game; }
  const sport = st.sport, label = SPORTS[sport].label;
  valueRows();
  const mine = sport === 'nfl' ? myRoster() : null;
  if (st.scope.nfl === 'mine' && !mine) st.scope.nfl = 'all';

  el.innerHTML = `
    <div class="page-head"><div>
      <h1>Live games</h1>
      <p class="sub">Box scores and fantasy points while games are being played, updated automatically: NFL on Thursdays, Sundays and Mondays, college on Saturdays. Click a game to see only its players.</p>
    </div>
    <div class="seg" data-k="sport">${Object.entries(SPORTS).map(([k, v]) => `<button data-v="${k}" class="${k === sport ? 'on' : ''}">${v.label}</button>`).join('')}</div></div>
    <div class="livebar" data-bar><span><span class="spinner"></span> Loading this week’s ${label} games…</span></div>
    <div class="gstrip" data-games></div>
    <div data-matchup></div>
    <div class="toolbar" data-tools hidden></div>
    <div data-note></div>
    <div class="tablewrap" data-table></div>
    <div class="more" data-more></div>
    <p class="muted small">Live stats from <a class="link" href="https://docs.sleeper.com" target="_blank" rel="noopener">Sleeper</a> (Sportradar data), checked every ${SPORTS[sport].every / 1000} seconds while games are on. They can trail the broadcast by a minute and are sometimes corrected after the game.${sport === 'cfb' ? ' College players link to their profiles when they match a player in this app’s college data.' : ''}</p>`;
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

  let data = null, err = null, fresh = false, loading = false, timer = null, waiting = false, schools = new Map();

  const prepare = d => {
    const sc = scoringFor(sport), pv = prev[sport];
    const key = `${wk.season}|${wk.week}|${JSON.stringify(sc)}`;
    if (pv.key !== key || Date.now() - pv.t > IDLE) { pv.key = key; pv.pts = new Map(); }
    pv.t = Date.now();
    const m = sport === 'cfb' && ctx ? matchCollege(d.rows, ctx.pool) : null;
    schools = m?.school || new Map();
    const byGame = new Map(d.games.map(g => [g.id, g]));
    for (const r of d.rows) {
      r.pts = livePoints(r.stats, sc);
      const before = pv.pts.get(r.id);
      r.delta = before == null ? 0 : r.pts - before;
      pv.pts.set(r.id, r.pts);
      r.game = byGame.get(r.gameId) || null;
      if (sport === 'nfl') {
        r.p = S.byId.get(r.id) || null;
        r.dyn = r.p ? S.rowById.get(r.p.id) || null : null;
        r.snap = r.stats.off_snp && r.stats.tm_off_snp ? r.stats.off_snp / r.stats.tm_off_snp : null;
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
  const drawBar = () => {
    const g = data?.games || [];
    const n = s => g.filter(x => x.state === s).length;
    const parts = [`Week ${wk.week}${wk.type === 'post' ? ' (postseason)' : ''}`];
    if (n('live')) parts.push(`<span class="lv"><i></i>${n('live')} live</span>`);
    if (n('final')) parts.push(`${n('final')} final`);
    if (n('pre')) parts.push(`${n('pre')} still to play`);
    const when = data ? `Updated ${clock(data.fetched)} · ${data.live ? `updates every ${SPORTS[sport].every / 1000} s` : 'checks for kickoffs every 5 min'}` : '';
    $('[data-bar]').innerHTML = `<span>${parts.join(' · ')}</span><span class="muted small">${when}${err ? ` · <span class="down">couldn’t update (${esc(err)}); trying again</span>` : ''}</span>
      <button class="btn" data-act="refresh">Refresh</button>`;
  };

  const chip = g => {
    const scored = g.hs != null;
    const win = scored && g.state === 'final' ? (g.as > g.hs ? 'a' : g.hs > g.as ? 'h' : '') : '';
    const team = (t, s, w) => `<span class="gt${w ? ' w' : ''}"><span>${esc(t || '?')}</span>${scored ? `<b>${s}</b>` : ''}</span>`;
    const status = g.state === 'live' ? liveTag : g.state === 'final' ? 'Final' : esc(day(g.date));
    const full = sport === 'cfb' && (schoolOf(g.away) || schoolOf(g.home)) ? `${schoolOf(g.away) || g.away} ${g.vs ? 'vs' : 'at'} ${schoolOf(g.home) || g.home}` : `${g.away} ${g.vs ? 'vs' : 'at'} ${g.home}`;
    return `<button class="gchip ${g.state}${st.game === g.id ? ' on' : ''}" data-game="${esc(g.id)}" title="${esc(full)}">${team(g.away, g.as, win === 'a')}${team(g.home, g.hs, win === 'h')}<span class="gs">${status}</span></button>`;
  };
  const drawGames = () => {
    const tracked = new Map();
    if (sport === 'cfb') for (const r of data.rows) if (r.board) tracked.set(r.gameId, (tracked.get(r.gameId) || 0) + 1);
    const g = [...data.games].sort((a, b) => ORDER[a.state] - ORDER[b.state] || (tracked.get(b.id) || 0) - (tracked.get(a.id) || 0)
      || String(a.date).localeCompare(String(b.date)) || String(a.away).localeCompare(String(b.away)));
    $('[data-games]').innerHTML = g.map(chip).join('');
  };

  const scopes = () => (sport === 'nfl'
    ? [['all', 'All players'], ...(mine ? [['mine', 'My team (Sleeper)']] : []), ['rookies', 'Rookies']]
    : [['board', 'On the prospect board'], ...(ctx?.classes || []).map(c => [`c${c}`, `${c} draft class`]), ['all', 'All players']]);
  const drawTools = () => {
    const t = $('[data-tools]');
    t.hidden = false;
    t.innerHTML = `
      <div class="seg" data-k="pos">${['ALL', ...SKILL].map(p => `<button data-v="${p}" class="${st.pos === p ? 'on' : ''}">${p === 'ALL' ? 'All' : p}</button>`).join('')}</div>
      <select data-k="scope" aria-label="Which players">${scopes().map(([v, l]) => `<option value="${v}" ${v === st.scope[sport] ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <input type="search" placeholder="Search player or team" value="${esc(st.q)}" data-k="q">`;
  };

  const visible = () => {
    let list = data.rows;
    if (st.pos !== 'ALL') list = list.filter(r => r.pos === st.pos);
    // one game: everyone in it; otherwise the chosen group
    if (st.game) list = list.filter(r => r.gameId === st.game);
    else {
      const sc = st.scope[sport];
      if (sc === 'mine' && mine) list = list.filter(r => mine.players.has(r.id));
      else if (sc === 'rookies') list = list.filter(r => r.p && isRookie(r.p));
      else if (sc === 'board') list = list.filter(r => r.board);
      else if (/^c\d+$/.test(sc)) list = list.filter(r => r.board?.cls === Number(sc.slice(1)));
    }
    const q = st.q.trim();
    if (q) {
      const ql = q.toLowerCase();
      list = list.filter(r => nameMatch(r.name, q) || [r.team, schoolOf(r.team)].some(t => t && t.toLowerCase().startsWith(ql)));
    }
    return list;
  };

  const who = r => {
    if (sport === 'nfl') {
      const role = mine?.players.has(r.id) ? `<span class="tag rk" title="On your Sleeper roster">${mine.starters.has(r.id) ? 'Starter' : 'Bench'}</span>` : '';
      if (r.p) return playerCell(r.p, { size: 28, sub: `${posTag(r.p.pos)}<span>${esc(r.p.team || r.team)}</span>${isRookie(r.p) ? '<span class="tag rk" title="Rookie">R</span>' : ''}${injTag(r.p.inj)}${role}` });
      return `<span class="pcell">${headshot({ sid: r.id }, 28)}<div><div class="nm">${esc(r.name)}</div><div class="meta">${posTag(r.pos)}<span>${esc(r.team)}</span>${role}</div></div></span>`;
    }
    const meta = `${posTag(r.pos)}<span title="${esc(schoolOf(r.team))}">${esc(r.team)}</span>`;
    if (!r.cid) return `<span class="pcell"><span class="hs" style="width:28px;height:28px;display:inline-block"></span><div><div class="nm">${esc(r.name)}</div><div class="meta">${meta}</div></div></span>`;
    return `<a class="pcell" href="#/college/player/${esc(r.cid)}"><img class="hs" loading="lazy" width="28" height="28" style="width:28px;height:28px" src="${esc(collegeHeadshot(r.cid))}" alt="" onerror="this.style.visibility='hidden'"><div><div class="nm">${esc(r.name)}</div><div class="meta">${meta}</div></div></a>`;
  };
  const gameCell = r => {
    const g = r.game;
    if (!g) return `vs ${esc(r.opp || '?')}`;
    const home = g.vs || r.team === g.home;
    const score = g.hs != null ? ` · ${home ? g.hs : g.as}–${home ? g.as : g.hs}` : '';
    const status = g.state === 'live' ? `<span class="lv" title="In progress"><i></i></span>` : g.state === 'final' ? '<span class="muted">Final</span>' : '';
    return `${home ? 'vs' : '@'} ${esc(r.opp)}${score} ${status}`;
  };
  const ptsCell = r => {
    const d = Math.abs(r.delta) >= 0.05 ? ` <span class="dpts ${r.delta > 0 ? 'up' : 'down'}" title="Since the last update">${r.delta > 0 ? '+' : '−'}${fmt1(Math.abs(r.delta))}</span>` : '';
    return `<b>${fmt1(r.pts)}</b>${d}`;
  };

  const drawTable = () => {
    const note = $('[data-note]');
    if (!data) {
      $('[data-table]').innerHTML = `<div class="empty">${err ? `Couldn’t load live stats from Sleeper (${esc(err)}). Trying again shortly.` : '<span class="spinner"></span>'}</div>`;
      return;
    }
    const g = st.game ? data.games.find(x => x.id === st.game) : null;
    note.innerHTML = g ? `<div class="note">Showing everyone in <b>${esc(g.away)} ${g.vs ? 'vs' : '@'} ${esc(g.home)}</b>. <button class="linkbtn" data-act="allgames">Show all games</button></div>` : '';
    if (!data.rows.length) {
      const next = data.games.filter(x => x.state === 'pre').sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
      $('[data-table]').innerHTML = `<div class="empty">No ${label} game has kicked off yet this week${next ? ` · next up ${esc(day(next.date))}` : ''}.</div>`;
      $('[data-more]').innerHTML = '';
      return;
    }
    const cols = [
      { key: 'rk', label: '#', n: true, cell: (r, i) => `<td class="rank">${i + 1}</td>` },
      { key: 'name', label: 'Player', sort: r => r.name, cell: r => `<td>${who(r)}</td>` },
      { key: 'game', label: 'Game', sort: r => ORDER[r.game?.state] ?? 3, cell: r => `<td class="small">${gameCell(r)}</td>` },
      { key: 'pts', label: 'Pts', n: true, title: `Fantasy points (${ptsLabel(sport)})`, sort: r => r.pts, cell: r => `<td class="n">${ptsCell(r)}</td>` },
      { key: 'line', label: 'Stat line', cell: r => `<td class="small">${esc(statLine(r.stats, r.pos)) || '<span class="muted">—</span>'}</td>` },
      ...(sport === 'nfl' ? [
        { key: 'snap', label: 'Snaps', n: true, title: 'Share of the team’s offensive snaps (filled in after the game)', sort: r => r.snap, cell: r => `<td class="n">${r.snap != null ? `${Math.round(r.snap * 100)}%` : '<span class="muted">—</span>'}</td>` },
        { key: 'val', label: 'Dynasty', n: true, title: 'Dynasty market rank at his position (FantasyCalc)', sort: r => r.dyn?.market || null, cell: r => `<td class="n">${r.dyn?.mktPosRank ? `${r.pos}${r.dyn.mktPosRank}` : '<span class="muted">—</span>'}</td>` },
      ] : [
        { key: 'board', label: 'Board', n: true, title: 'Rank on the prospect board (Prospects tab) and draft class', sort: r => (r.board ? r.board.cls * 10000 + r.board.rank : null), cell: r => `<td class="n">${r.board ? `#${r.board.rank} <span class="muted">’${String(r.board.cls).slice(2)}</span>` : '<span class="muted">—</span>'}</td>` },
      ]),
    ];
    const list = sortRows(visible(), cols, st.sort, st.dir);
    $('[data-table]').innerHTML = table({
      cols, rows: list.slice(0, st.limit), sort: st.sort, dir: st.dir, cls: 'pin live-table',
      rowClass: r => [fresh && Math.abs(r.delta) >= 0.05 ? 'bump' : '', sport === 'nfl' && st.scope.nfl !== 'mine' && mine?.players.has(r.id) ? 'me' : ''].filter(Boolean).join(' '),
    });
    const scopeEmpty = !list.length && !st.game && !st.q && st.pos === 'ALL';
    $('[data-more]').innerHTML = list.length > st.limit ? `<button class="btn" data-act="more">Show more (${list.length - st.limit} left)</button>`
      : scopeEmpty ? `<span class="muted small">None of these players has played yet this week.</span>`
        : `<span class="muted small">${list.length} player${list.length === 1 ? '' : 's'} with a stat this week · points: ${esc(ptsLabel(sport))}${sport === 'nfl' && mine ? ' · highlighted: your Sleeper roster' : ''}</span>`;
  };

  const draw = () => {
    if (!alive()) return;
    drawBar();
    if (data) { drawGames(); if ($('[data-tools]').hidden) drawTools(); }
    drawTable();
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
  el.addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      st.dir = st.sort === k ? (st.dir === 'asc' ? 'desc' : 'asc') : ['name', 'board', 'game'].includes(k) ? 'asc' : 'desc';
      st.sort = k; drawTable(); return;
    }
    const chipEl = e.target.closest('[data-game]');
    if (chipEl) { st.game = st.game === chipEl.dataset.game ? null : chipEl.dataset.game; st.limit = 100; drawGames(); drawTable(); return; }
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'refresh') { clearTimeout(timer); refresh().then(plan); return; }
    if (act === 'more') { st.limit += 100; drawTable(); return; }
    if (act === 'allgames') { st.game = null; drawGames(); drawTable(); return; }
    if (act === 'mine') { st.scope.nfl = 'mine'; st.game = null; drawTools(); drawGames(); drawTable(); return; }
    const seg = b.closest('.seg');
    if (seg?.dataset.k === 'sport' && b.dataset.v !== sport) { location.hash = `#/live?sport=${b.dataset.v}`; return; }
    if (seg?.dataset.k === 'pos') {
      st.pos = b.dataset.v; st.limit = 100;
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      drawTable();
    }
  });
  el.addEventListener('change', e => { if (e.target.dataset.k === 'scope') { st.scope[sport] = e.target.value; st.game = null; st.limit = 100; drawGames(); drawTable(); } });
  el.addEventListener('input', e => { if (e.target.dataset.k === 'q') { st.q = e.target.value; st.limit = 100; drawTable(); } });

  await refresh();
  plan();
}

// ---------- "this week" lines on player pages (refreshed every minute while his game is on) ----------
function strip(box, { week, state, opp, date, line, pts, label, href }) {
  const status = state === 'live' ? liveTag : state === 'final' ? '<span class="muted">Final</span>' : `<span class="muted">${esc(day(date))}</span>`;
  box.innerHTML = `<div class="card livestrip"><b>Week ${week}</b><span>${esc(opp)}</span>${status}
    ${line != null ? `<span>${esc(line) || 'no stats yet'}</span><span><b>${fmt1(pts)}</b> ${esc(label)} pts</span>` : '<span class="muted">no stats yet</span>'}
    <a class="link" href="${href}">Live scores →</a></div>`;
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
      week: w.week, state, opp, date: g?.date, line: row ? statLine(row.stats, p.pos) : null,
      pts: row ? livePoints(row.stats, scoringFor('nfl')) : null, label: scoringLabel(), href: `#/live?sport=nfl${g ? `&game=${encodeURIComponent(g.game_id)}` : ''}`,
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
    const row = d.rows.find(r => ids.get(r.id) === String(cid));
    if (!row) { box.innerHTML = ''; return false; }
    const g = d.games.find(x => x.id === row.gameId);
    const home = !g || g.vs || g.home === row.team;
    strip(box, {
      week: w.week, state: g?.state || 'live', opp: `${home ? 'vs' : '@'} ${row.opp}`, date: g?.date, line: statLine(row.stats, pos),
      pts: livePoints(row.stats, scoringFor('cfb')), label: ptsLabel('cfb'), href: `#/live?sport=cfb&game=${encodeURIComponent(row.gameId)}`,
    });
    return g?.state === 'live';
  });
}
