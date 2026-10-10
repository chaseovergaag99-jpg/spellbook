/**
 * views/collection.js — Collection tab: totals, price refresh, sort/filter,
 * list/grid display. Tap an entry to edit it in the card sheet.
 */
import * as store from '../store.js';
import * as sf from '../scryfall.js';
import { $, esc, money, priceStr, deltaHtml, timeAgo, toast, COLOR_VAR } from '../ui.js';
import { SORTS, applySortFilter } from '../sorting.js';
import { openCardSheet } from '../cardsheet.js';

const PREFS_KEY = 'spellbook:collectionPrefs';
const prefs = { sort: 'added', dir: -1, text: '', colors: [], rarities: [], layout: 'list', ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, text: '' }));

let el;

export function mount(root) {
  el = root;
  el.innerHTML = `
    <div class="view-header"><h1>Collection</h1>
      <button class="btn small" id="c-refresh">↻ Refresh prices</button></div>
    <div class="summary" id="c-summary"></div>
    <div class="small muted" id="c-updated" style="margin:-2px 2px 10px"></div>
    <div class="row">
      <input class="grow" id="c-text" type="search" placeholder="Filter by name, type, set, text…" aria-label="Filter collection">
      <button class="btn icon-btn" id="c-layout" aria-label="Toggle grid/list"></button>
    </div>
    <div class="row" style="margin-top:8px">
      <select class="grow" id="c-sort" aria-label="Sort by">${Object.entries(SORTS).map(([k, s]) => `<option value="${k}">Sort: ${s.label}</option>`).join('')}</select>
      <button class="btn icon-btn" id="c-dir" aria-label="Sort direction"></button>
    </div>
    <div class="chips" id="c-colors" style="margin-top:6px">
      ${['W', 'U', 'B', 'R', 'G', 'C', 'M'].map((c) => `<button class="chip" data-color="${c}"><span class="dot" style="background:${COLOR_VAR[c]}"></span>${{ W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless', M: 'Multi' }[c]}</button>`).join('')}
    </div>
    <div class="chips" id="c-rarity">
      ${['common', 'uncommon', 'rare', 'mythic'].map((r) => `<button class="chip" data-rarity="${r}">${r[0].toUpperCase() + r.slice(1)}</button>`).join('')}
    </div>
    <div id="c-list" style="margin-top:8px"></div>`;

  $('#c-text', el).addEventListener('input', (e) => { prefs.text = e.target.value; renderList(); });
  $('#c-sort', el).addEventListener('change', (e) => {
    prefs.sort = e.target.value;
    prefs.dir = ['price', 'value', 'added'].includes(prefs.sort) ? -1 : 1; // sensible defaults
    savePrefs(); render();
  });
  $('#c-dir', el).addEventListener('click', () => { prefs.dir *= -1; savePrefs(); render(); });
  $('#c-layout', el).addEventListener('click', () => { prefs.layout = prefs.layout === 'list' ? 'grid' : 'list'; savePrefs(); render(); });
  $('#c-colors', el).addEventListener('click', (e) => toggleChip(e, 'color', 'colors'));
  $('#c-rarity', el).addEventListener('click', (e) => toggleChip(e, 'rarity', 'rarities'));
  $('#c-refresh', el).addEventListener('click', refreshPrices);
  $('#c-list', el).addEventListener('click', (e) => {
    const b = e.target.closest('[data-uid]'); if (!b) return;
    const entry = store.state.collection.find((x) => x.uid === b.dataset.uid);
    if (entry) openCardSheet(store.state.cards[entry.cardId], { entry });
  });
  render();
}

function toggleChip(e, attr, key) {
  const b = e.target.closest(`[data-${attr}]`); if (!b) return;
  const v = b.dataset[attr];
  prefs[key] = prefs[key].includes(v) ? prefs[key].filter((x) => x !== v) : [...prefs[key], v];
  savePrefs(); render();
}

export function render() {
  if (!el) return;
  const { collection, cards, meta } = store.state;
  const { total, delta } = store.collectionValue();
  const count = collection.reduce((n, e) => n + e.qty, 0);
  $('#c-summary', el).innerHTML = `
    <div class="stat"><div class="k">Cards</div><div class="v">${count.toLocaleString()}</div></div>
    <div class="stat"><div class="k">Unique</div><div class="v">${collection.length.toLocaleString()}</div></div>
    <div class="stat"><div class="k">Value</div><div class="v price">${money(total)}</div><div>${deltaHtml(delta)}</div></div>`;
  $('#c-updated', el).textContent = `Prices updated ${timeAgo(meta.lastRefresh)} · TCGplayer market via Scryfall`;
  $('#c-sort', el).value = prefs.sort;
  $('#c-dir', el).textContent = prefs.dir === 1 ? '↑' : '↓';
  $('#c-layout', el).textContent = prefs.layout === 'list' ? '▦' : '☰';
  el.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', prefs.colors.includes(b.dataset.color)));
  el.querySelectorAll('[data-rarity]').forEach((b) => b.classList.toggle('on', prefs.rarities.includes(b.dataset.rarity)));
  renderList();
}

function renderList() {
  const { collection, cards } = store.state;
  const list = $('#c-list', el);
  if (!collection.length) {
    list.innerHTML = `<div class="empty"><div class="big">📦</div><p>Your collection is empty.</p><p class="small">Use <b>Search</b> or <b>Scan</b> to add cards.</p></div>`;
    return;
  }
  const rows = collection.map((e) => ({ ...e, card: cards[e.cardId], price: store.unitPrice(cards[e.cardId], e.foil) })).filter((r) => r.card);
  const shown = applySortFilter(rows, { ...prefs, colors: new Set(prefs.colors), rarities: new Set(prefs.rarities) });
  if (!shown.length) { list.innerHTML = `<div class="empty">No cards match these filters.</div>`; return; }

  if (prefs.layout === 'grid') {
    list.innerHTML = `<div class="grid">${shown.map((r) => `
      <button class="grid-card" data-uid="${esc(r.uid)}">
        <div class="img">${r.card.image ? `<img loading="lazy" src="${esc(r.card.image)}" alt="${esc(r.card.name)}">` : ''}</div>
        <div class="meta"><span>${r.qty}× ${r.foil ? '✦' : ''}${esc(r.card.set.toUpperCase())}</span><b>${money(r.price)}</b></div>
      </button>`).join('')}</div>`;
    return;
  }
  list.innerHTML = `<div class="list">${shown.map((r) => {
    const prev = store.prevUnitPrice(r.card, r.foil);
    return `<button class="item" data-uid="${esc(r.uid)}">
      <div class="thumb">${r.card.image_small ? `<img loading="lazy" src="${esc(r.card.image_small)}" alt="">` : ''}</div>
      <div class="body">
        <div class="name">${esc(r.card.name)} ${r.foil ? '<span class="badge foil">FOIL</span>' : ''}</div>
        <div class="sub">${esc(r.card.set_name)} · ${esc(r.card.rarity)}${r.condition && r.condition !== 'NM' ? ' · ' + esc(r.condition) : ''}</div>
        <div class="sub">${esc(r.card.type_line)}</div>
      </div>
      <div class="right"><div class="qty">×${r.qty}</div><div class="price">${money(r.price)}</div>
        ${prev != null ? deltaHtml(r.price - prev) : ''}</div>
    </button>`;
  }).join('')}</div>`;
}

/** Batch-refresh every cached card's prices through /cards/collection (75 ids/request). */
export async function refreshPrices() {
  const ids = Object.keys(store.state.cards);
  if (!ids.length) return toast('Nothing to refresh yet');
  const btn = $('#c-refresh', el);
  btn.disabled = true;
  try {
    const { found } = await sf.collection(ids.map((id) => ({ id })), (done, n) => (btn.textContent = `↻ ${done}/${n}`));
    for (const fresh of found) {
      const old = store.state.cards[fresh.id];
      store.state.cards[fresh.id] = { ...fresh, prev: old ? { ...old.prices } : null };
    }
    store.state.meta.lastRefresh = new Date().toISOString();
    store.state.meta.lastRefreshTotal = store.collectionValue().total;
    store.save();
    const { delta } = store.collectionValue();
    toast(`Updated ${found.length} card${found.length === 1 ? '' : 's'}${delta ? ` · ${delta >= 0 ? '+' : '−'}${money(Math.abs(delta))}` : ''}`);
  } catch (e) {
    toast('Refresh failed: ' + e.message, 4000);
  } finally {
    btn.disabled = false; btn.textContent = '↻ Refresh prices';
  }
}
