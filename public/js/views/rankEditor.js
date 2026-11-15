// An editable ranking table: drag a row by its handle (mouse or touch), use the arrows, or type a new rank.
import { moveKey, moveTo } from '../myranks.js';

/**
 * Draw the editor into box.
 * order: every key, best first (the whole ranking); keys: the ones to show, in that order (a filtered view);
 * who(key): the player cell's HTML; head: extra <th>s; cells(key): extra <td>s; onChange(newOrder) after each move.
 */
export function rankEditor(box, { order, keys, who, head = '', cells = () => '', onChange }) {
  box._re = { order, keys, onChange };
  const pos = new Map(order.map((k, i) => [k, i + 1]));
  box.innerHTML = `<div class="tablewrap"><table class="data ranked"><thead><tr><th aria-label="Drag"></th><th class="n">#</th><th>Player</th>${head}<th class="n">Move</th></tr></thead><tbody>${
    keys.map(k => `<tr data-key="${encodeURIComponent(k)}"><td class="grip" title="Drag to move" aria-hidden="true">⋮⋮</td>
      <td class="n"><input class="rk" type="number" min="1" max="${order.length}" value="${pos.get(k)}" aria-label="Rank" title="Type a rank and press Enter"></td>
      <td>${who(k)}</td>${cells(k)}<td class="n mv"><button class="icon-btn" data-mv="up" aria-label="Move up">▲</button><button class="icon-btn" data-mv="down" aria-label="Move down">▼</button></td></tr>`).join('')
    || '<tr><td colspan="9" class="empty">No players match.</td></tr>'}</tbody></table></div>`;
  if (box._reBound) return;
  box._reBound = true;
  const keyOf = tr => decodeURIComponent(tr.dataset.key);
  const apply = order2 => { if (order2 !== box._re.order) box._re.onChange(order2); };

  box.addEventListener('click', e => {
    const b = e.target.closest('[data-mv]');
    if (!b) return;
    const { order: o, keys: ks } = box._re, k = keyOf(b.closest('tr')), i = ks.indexOf(k);
    if (b.dataset.mv === 'up' && i > 0) apply(moveKey(o, k, ks[i - 1]));
    if (b.dataset.mv === 'down' && i < ks.length - 1) apply(moveKey(o, k, ks[i + 1], true));
  });
  box.addEventListener('change', e => {
    if (!e.target.classList.contains('rk')) return;
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 1) apply(moveTo(box._re.order, keyOf(e.target.closest('tr')), v));
  });
  box.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('rk')) e.target.blur(); });

  // dragging by the handle, with pointer events so it works with a finger too
  let drag = null;
  const clear = () => box.querySelectorAll('.drop-above, .drop-below, .dragging').forEach(x => x.classList.remove('drop-above', 'drop-below', 'dragging'));
  box.addEventListener('pointerdown', e => {
    const g = e.target.closest('.grip');
    if (!g) return;
    e.preventDefault();
    const tr = g.closest('tr');
    drag = { key: keyOf(tr), target: null, after: false, id: e.pointerId };
    tr.classList.add('dragging');
    try { g.setPointerCapture(e.pointerId); } catch { /* moves still reach the table */ }
  });
  box.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    // keep the page scrolling while dragging near the top or bottom of the window
    if (e.clientY < 60) window.scrollBy(0, -12); else if (e.clientY > innerHeight - 60) window.scrollBy(0, 12);
    const tr = document.elementFromPoint(e.clientX, e.clientY)?.closest('tr[data-key]');
    box.querySelectorAll('.drop-above, .drop-below').forEach(x => x.classList.remove('drop-above', 'drop-below'));
    if (!tr || !box.contains(tr)) { drag.target = null; return; }
    const r = tr.getBoundingClientRect();
    drag.target = keyOf(tr); drag.after = e.clientY > r.top + r.height / 2;
    tr.classList.add(drag.after ? 'drop-below' : 'drop-above');
  });
  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null; clear();
    if (d.target && d.target !== d.key) apply(moveKey(box._re.order, d.key, d.target, d.after));
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', e => { if (drag && e.pointerId === drag.id) { drag = null; clear(); } });
}
