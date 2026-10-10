/**
 * cardsheet.js — the card detail bottom sheet used everywhere.
 *
 *  openCardSheet(card, { entry, deckId })
 *    - card:   SlimCard to show
 *    - entry:  (optional) collection entry being edited -> shows Save/Remove
 *    - deckId: (optional) preselect this deck in the "Add to deck" picker
 *
 * Lets the user switch printing (set), toggle foil, set qty/condition,
 * and add to the collection or to a deck section.
 */
import * as sf from './scryfall.js';
import * as store from './store.js';
import { esc, priceStr, manaHtml, openSheet, closeSheet, toast, stepperHtml, wireSteppers } from './ui.js';

const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];

export function deckPickerHtml(selectedId) {
  const opts = store.state.decks.map((d) => `<option value="${esc(d.id)}" ${d.id === selectedId ? 'selected' : ''}>${esc(d.name)} · ${esc(d.format)}</option>`).join('');
  return `<div class="row">
    <select class="grow" data-deck-pick>${opts}<option value="__new">＋ New deck…</option></select>
    <select data-section style="width:auto"><option value="main">Main</option><option value="side">Side</option><option value="commander">Cmdr</option></select>
  </div>`;
}
/** Resolve the deck picker (creating a deck if "New deck…" chosen). */
export function resolveDeckPick(root) {
  let id = root.querySelector('[data-deck-pick]').value;
  if (id === '__new') {
    const name = prompt('Deck name', 'New Deck');
    if (!name) return null;
    id = store.createDeck(name, 'Commander').id;
  }
  return { deckId: id, section: root.querySelector('[data-section]').value };
}

export function openCardSheet(card, { entry = null, deckId = null } = {}) {
  let current = card;
  const isEdit = !!entry;
  const owned = store.ownedCountByName(card.name);

  const render = () => `
    <div class="detail-top">
      <div class="img" id="cs-img">${current.image ? `<img src="${esc(current.image)}" alt="${esc(current.name)}">` : ''}</div>
      <div style="min-width:0">
        <h2>${esc(current.name)}</h2>
        <div class="small" style="margin:4px 0">${manaHtml(current.mana_cost)}</div>
        <div class="small muted">${esc(current.type_line)}</div>
        <div class="small muted" id="cs-set">${esc(current.set_name)} (${esc(current.set.toUpperCase())}) #${esc(current.collector_number)} · ${esc(current.rarity)}</div>
        <div class="price-row" id="cs-prices">${pricesHtml(current)}</div>
        ${owned ? `<span class="badge owned">Owned: ${owned}</span>` : ''}
      </div>
    </div>
    <div class="oracle">${esc(current.oracle_text || '')}</div>
    <div class="row wrap small" id="cs-links">${linksHtml(current)}</div>

    <label class="field"><span>Printing / set</span>
      <select id="cs-print"><option value="${esc(current.id)}">${esc(printLabel(current))}</option></select>
    </label>
    <div class="row wrap" style="justify-content:space-between">
      ${stepperHtml('qty', entry?.qty ?? 1)}
      <label class="switch"><input type="checkbox" id="cs-foil" ${entry?.foil ? 'checked' : ''}> Foil</label>
      <select id="cs-cond" style="width:auto" aria-label="Condition">${CONDITIONS.map((c) => `<option ${c === (entry?.condition || 'NM') ? 'selected' : ''}>${c}</option>`).join('')}</select>
    </div>

    ${isEdit
      ? `<div class="actions"><button class="btn primary" id="cs-save">Save</button><button class="btn danger" id="cs-remove">Remove</button></div>`
      : `<button class="btn primary block" id="cs-add" style="margin-top:12px">＋ Add to Collection</button>`}
    <div class="section-title">Add to deck</div>
    ${deckPickerHtml(deckId)}
    <button class="btn block" id="cs-deck" style="margin-top:8px">＋ Add to Deck</button>
  `;

  const root = openSheet(render());
  const qty = wireSteppers(root);

  // Lazy-load all printings into the select.
  const sel = root.querySelector('#cs-print');
  sf.printings(card.name).then((prints) => {
    if (!prints.length || !root.isConnected) return;
    if (!prints.find((p) => p.id === current.id)) prints.unshift(current);
    sel.innerHTML = prints.map((p) => `<option value="${esc(p.id)}" ${p.id === current.id ? 'selected' : ''}>${esc(printLabel(p))}</option>`).join('');
    sel._prints = prints;
  }).catch(() => {});
  sel.addEventListener('change', () => {
    const p = sel._prints?.find((x) => x.id === sel.value);
    if (!p) return;
    current = p;
    root.querySelector('#cs-img').innerHTML = p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}">` : '';
    root.querySelector('#cs-set').textContent = `${p.set_name} (${p.set.toUpperCase()}) #${p.collector_number} · ${p.rarity}`;
    root.querySelector('#cs-prices').innerHTML = pricesHtml(p);
    root.querySelector('#cs-links').innerHTML = linksHtml(p);
  });

  const opts = () => ({ qty: qty('qty'), foil: root.querySelector('#cs-foil').checked, condition: root.querySelector('#cs-cond').value });

  root.querySelector('#cs-add')?.addEventListener('click', () => {
    const o = opts();
    store.addToCollection(current, o);
    toast(`Added ${o.qty}× ${current.name}${o.foil ? ' (foil)' : ''}`);
    closeSheet();
  });
  root.querySelector('#cs-save')?.addEventListener('click', () => {
    const o = opts();
    store.upsertCard(current);
    store.updateEntry(entry.uid, { ...o, cardId: current.id });
    toast('Saved'); closeSheet();
  });
  root.querySelector('#cs-remove')?.addEventListener('click', () => {
    if (!confirm(`Remove ${card.name} from your collection?`)) return;
    store.removeEntry(entry.uid); toast('Removed'); closeSheet();
  });
  root.querySelector('#cs-deck').addEventListener('click', () => {
    const pick = resolveDeckPick(root); if (!pick) return;
    store.addToDeck(pick.deckId, current, { qty: qty('qty'), section: pick.section });
    toast(`Added to ${store.getDeck(pick.deckId).name}`);
    closeSheet();
  });
}

function printLabel(p) {
  const price = p.prices.usd ? ` · $${p.prices.usd}` : p.prices.usd_foil ? ` · $${p.prices.usd_foil} foil` : '';
  return `${p.set_name} (${p.set.toUpperCase()} #${p.collector_number})${price}`;
}
function pricesHtml(c) {
  return `<div>Normal<b>${priceStr(c.prices.usd)}</b></div><div>Foil<b>${priceStr(c.prices.usd_foil)}</b></div>`;
}
function linksHtml(c) {
  return `${c.tcgplayer ? `<a class="btn small" href="${esc(c.tcgplayer)}" target="_blank" rel="noopener">Buy on TCGplayer ↗</a>` : ''}
    ${c.scryfall_uri ? `<a class="btn small ghost" href="${esc(c.scryfall_uri)}" target="_blank" rel="noopener">Scryfall ↗</a>` : ''}`;
}
