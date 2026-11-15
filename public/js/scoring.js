// Custom scoring: the points your league gives for each stat, for a league that isn't on Sleeper or doesn't use
// the PPR / half / standard presets. Stored with your other settings in this browser, as Sleeper scoring_settings,
// so everything that handles league scoring (live points, player pages, rankings) handles it too.
import { S, persist, bump, scoringRules } from './store.js';
import { PRESETS } from './model.js';
import { esc } from './ui.js';

// [Sleeper stat, label, 'per' for yardage entered as yards per point]
const FIELDS = [
  ['Passing', [
    ['pass_yd', 'Yards per point', 'per'], ['pass_td', 'Touchdown'], ['pass_int', 'Interception'], ['pass_int_td', 'Pick-six thrown (extra)'],
    ['pass_2pt', '2-point conversion'], ['pass_sack', 'Sacked'], ['pass_cmp', 'Completion'], ['pass_inc', 'Incompletion'], ['pass_fd', 'First down'],
    ['bonus_pass_yd_300', '300-yard game bonus'], ['bonus_pass_yd_400', '400-yard game bonus'],
  ]],
  ['Rushing', [
    ['rush_yd', 'Yards per point', 'per'], ['rush_td', 'Touchdown'], ['rush_att', 'Carry'], ['rush_2pt', '2-point conversion'], ['rush_fd', 'First down'],
    ['bonus_rush_yd_100', '100-yard game bonus'], ['bonus_rush_yd_200', '200-yard game bonus'],
  ]],
  ['Receiving', [
    ['rec', 'Reception'], ['rec_yd', 'Yards per point', 'per'], ['rec_td', 'Touchdown'], ['rec_2pt', '2-point conversion'], ['rec_fd', 'First down'],
    ['bonus_rec_te', 'Extra per TE catch'], ['bonus_rec_rb', 'Extra per RB catch'], ['bonus_rec_wr', 'Extra per WR catch'],
    ['bonus_rec_yd_100', '100-yard game bonus'], ['bonus_rec_yd_200', '200-yard game bonus'],
  ]],
  ['Fumbles and returns', [['fum_lost', 'Fumble lost'], ['fum', 'Any fumble'], ['st_td', 'Kick or punt return TD'], ['fum_rec_td', 'Fumble recovered for a TD']]],
];

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const num = v => { const x = round(v); return x < 0 ? `−${-x}` : String(x); };
const per = v => round(1 / v, 1);

/** The main rules in a few words each: "4 per pass TD", "25 pass yds per pt", "−2 per INT"… */
export function scoringSummary(r) {
  const g = k => r[k] || 0, out = [];
  const yds = (k, what) => (g(k) ? `${per(g(k))} ${what} yds per pt` : `no points for ${what} yards`);
  out.push(`${num(g('pass_td'))} per pass TD`, yds('pass_yd', 'pass'), `${num(g('pass_int'))} per INT`);
  if (g('pass_int_td')) out.push(`${num(g('pass_int_td'))} more per pick-six`);
  out.push(`${num(g('fum_lost'))} per fumble lost`);
  if (g('fum')) out.push(`${num(g('fum'))} per fumble`);
  out.push(g('rec') ? `${num(g('rec'))} per catch` : 'no points per catch');
  for (const [k, p] of [['bonus_rec_te', 'TE'], ['bonus_rec_rb', 'RB'], ['bonus_rec_wr', 'WR']]) if (g(k)) out.push(`${p} catches +${num(g(k))}`);
  if (g('rush_td') === g('rec_td')) out.push(`${num(g('rush_td'))} per rush/rec TD`);
  else out.push(`${num(g('rush_td'))} per rush TD`, `${num(g('rec_td'))} per rec TD`);
  if (g('rush_yd') === g('rec_yd')) out.push(yds('rush_yd', 'rush/rec'));
  else out.push(yds('rush_yd', 'rush'), yds('rec_yd', 'rec'));
  for (const [k, w] of [['pass_cmp', 'completion'], ['pass_inc', 'incompletion'], ['pass_sack', 'sack taken'], ['rush_att', 'carry']]) if (g(k)) out.push(`${num(g(k))} per ${w}`);
  if (['pass_fd', 'rush_fd', 'rec_fd', 'bonus_fd_qb', 'bonus_fd_rb', 'bonus_fd_wr', 'bonus_fd_te'].some(g)) out.push('first downs score');
  if (Object.keys(r).some(k => /^bonus_(pass|rush|rec|rush_rec)_yd_/.test(k) && g(k))) out.push('big-game bonuses');
  return out;
}

let dlg = null;
function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'dlg';
  dlg.setAttribute('aria-labelledby', 'scoring-title');
  dlg.innerHTML = `<form method="dialog">
    <div class="dlg-head"><h2 id="scoring-title">Custom scoring</h2><button class="icon-btn" value="cancel" aria-label="Close">✕</button></div>
    <p class="muted small" style="margin:0 0 12px">The points your league gives for each stat, as on its settings page. They’re used for live points, player pages and rankings. Yardage is in yards per point (25 passing yards per point is 0.04 a yard); 0 means no points.</p>
    <div class="dlg-start"><span class="small muted">Start from</span><div class="seg" data-start></div></div>
    <div class="sgrid">${FIELDS.map(([g, fs]) => `<fieldset><legend>${g}</legend>${fs.map(([k, l, kind]) => `<label><span>${l}</span><input type="number" step="any" inputmode="decimal" name="${k}"${kind ? ` data-per` : ''}></label>`).join('')}</fieldset>`).join('')}</div>
    <div class="dlg-foot"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="save">Save scoring</button></div>
  </form>`;
  document.body.append(dlg);
}
// what an unset stat is worth: return TDs count 6 unless the scoring says otherwise
const DEFAULT = { st_td: 6 };
const inputs = () => [...dlg.querySelectorAll('input[name]')];
function fill(r) {
  for (const i of inputs()) {
    const v = r[i.name] ?? DEFAULT[i.name] ?? 0;
    i.value = i.dataset.shown = i.hasAttribute('data-per') ? (v ? per(v) : 0) : round(v);
  }
}
function read(base) {
  const out = { ...base };
  for (const i of inputs()) {
    if (i.value === i.dataset.shown) continue; // untouched: keep the exact value (0.033 shows as 30.3 yards per point)
    const v = Number(i.value);
    out[i.name] = !Number.isFinite(v) || !v ? 0 : i.hasAttribute('data-per') ? 1 / v : v;
  }
  return out;
}

/**
 * Open the editor, starting from your custom scoring (or the scoring in use). Saving stores it and switches to it;
 * resolves true when saved, false when cancelled. Callers reload values and redraw.
 */
export function editCustomScoring() {
  if (!dlg) build();
  const starts = [
    ...(S.league ? [['league', `My league (${S.league.info.name})`, S.league.scoring]] : []),
    ['ppr', 'PPR', PRESETS.ppr], ['half', 'Half PPR', PRESETS.half], ['std', 'Standard', PRESETS.std],
  ];
  let base = { ...(S.settings.scoring === 'custom' && S.settings.custom ? S.settings.custom : scoringRules()) };
  dlg.querySelector('[data-start]').innerHTML = starts.map(([v, l]) => `<button type="button" data-v="${v}">${esc(l)}</button>`).join('');
  fill(base);
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => {
    const onStart = e => {
      const b = e.target.closest('[data-start] button');
      if (!b) return;
      base = { ...starts.find(x => x[0] === b.dataset.v)[2] };
      fill(base);
      dlg.querySelectorAll('[data-start] button').forEach(x => x.classList.toggle('on', x === b));
    };
    dlg.addEventListener('click', onStart);
    dlg.addEventListener('close', () => {
      dlg.removeEventListener('click', onStart);
      if (dlg.returnValue !== 'save') { resolve(false); return; }
      S.settings.custom = read(base);
      S.settings.scoring = 'custom';
      S.settings.tep = S.settings.custom.bonus_rec_te || 0;
      persist(); bump();
      resolve(true);
    }, { once: true });
  });
}
