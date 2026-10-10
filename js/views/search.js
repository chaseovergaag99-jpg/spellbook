/**
 * views/search.js — Search tab: name autocomplete + full Scryfall search.
 * Tap a result to open the card sheet (add to collection / deck).
 */
import * as sf from '../scryfall.js';
import { $, esc, gridCard, attachAutocomplete, toast } from '../ui.js';
import { openCardSheet } from '../cardsheet.js';

const EXAMPLES = ['Lightning Bolt', 't:dragon c:r', 'o:"draw a card" cmc<=2', 'set:mh3 r:mythic', 'is:commander c:bg'];

export function mount(el) {
  el.innerHTML = `
    <div class="sticky">
      <form id="s-form" class="ac-wrap" autocomplete="off">
        <input id="s-q" type="search" placeholder="Search cards (name or Scryfall syntax)" enterkeyhint="search" aria-label="Search cards">
      </form>
    </div>
    <div id="s-info" class="small muted" style="margin:6px 2px 10px"></div>
    <div id="s-results"></div>
    <button id="s-more" class="btn block" style="margin-top:14px" hidden>Load more</button>`;

  const input = $('#s-q', el), results = $('#s-results', el), info = $('#s-info', el), more = $('#s-more', el);
  let cards = [], page = 1, query = '';

  const showHome = () => {
    info.textContent = '';
    results.innerHTML = `<div class="empty"><div class="big">🔎</div>
      <p>Search any Magic card. Prices are TCGplayer market prices via Scryfall.</p>
      <div class="chips" style="justify-content:center;flex-wrap:wrap">${EXAMPLES.map((x) => `<button class="chip" data-ex="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>`;
  };

  async function run(q, reset = true) {
    if (!q) return showHome();
    if (reset) { cards = []; page = 1; query = q; results.innerHTML = '<div class="spinner"></div>'; }
    more.hidden = true;
    try {
      const r = await sf.search(q, { page });
      cards.push(...r.cards);
      // Exact name matches first (e.g. "Lightning Bolt" before "Emeritus of Conflict // Lightning Bolt").
      const ql = q.toLowerCase().replace(/^!?"|"$/g, '');
      cards.sort((a, b) => (b.name.toLowerCase() === ql) - (a.name.toLowerCase() === ql));
      info.textContent = r.total ? `${r.total.toLocaleString()} card${r.total === 1 ? '' : 's'}` : '';
      results.innerHTML = cards.length
        ? `<div class="grid">${cards.map((c) => gridCard(c)).join('')}</div>`
        : `<div class="empty"><div class="big">🤷</div>No cards found for “${esc(q)}”.</div>`;
      more.hidden = !r.hasMore;
    } catch (e) {
      results.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`;
    }
  }

  attachAutocomplete(input, (name) => run(`!"${name}"`).then(() => cards.length === 1 && openCardSheet(cards[0])));
  $('#s-form', el).addEventListener('submit', (e) => { e.preventDefault(); input.blur(); run(input.value.trim()); });
  more.addEventListener('click', () => { page++; run(query, false); });
  results.addEventListener('click', (e) => {
    const ex = e.target.closest('[data-ex]');
    if (ex) { input.value = ex.dataset.ex; return run(ex.dataset.ex); }
    const b = e.target.closest('[data-card-id]');
    if (b) {
      const c = cards.find((x) => x.id === b.dataset.cardId);
      if (c) openCardSheet(c); else toast('Card not found');
    }
  });
  showHome();
}
