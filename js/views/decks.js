/**
 * views/decks.js — Decks tab.
 *   - Deck list (create / open)
 *   - Deck editor: add cards (search or from collection), sections
 *     (Commander / Main / Sideboard), counts, mana curve, color breakdown,
 *     total price, "not owned" flags, text import/export.
 */
import * as store from '../store.js';
import * as sf from '../scryfall.js';
import { $, esc, money, toast, openSheet, closeSheet, attachAutocomplete, manaHtml, COLOR_VAR, COLOR_NAMES, timeAgo, download } from '../ui.js';
import { primaryType } from '../sorting.js';
import { parseDecklist, formatDecklist } from '../decklist.js';
import { openCardSheet } from '../cardsheet.js';

let el;
let openId = null;          // currently open deck id (null = list)
let addSection = 'main';    // section new cards go to

const SECTION_LABEL = { commander: 'Commander', main: 'Main deck', side: 'Sideboard' };
const TARGET = (fmt) => (['Commander', 'Brawl'].includes(fmt) ? (fmt === 'Brawl' ? 60 : 100) : fmt === 'Limited' ? 40 : 60);

export function mount(root) { el = root; render(); }
export function openDeck(id) { openId = id; render(); window.scrollTo(0, 0); }

export function render() {
  if (!el) return;
  const deck = openId && store.getDeck(openId);
  if (!deck) { openId = null; return renderList(); }
  // Re-render the editor but keep the add-card input if focused.
  renderDeck(deck);
}

/* ======================= deck list ======================= */
function renderList() {
  const { decks, cards } = store.state;
  el.innerHTML = `
    <div class="view-header"><h1>Decks</h1>
      <div class="row"><button class="btn small" id="d-import-new">Import</button><button class="btn small primary" id="d-new">＋ New</button></div></div>
    ${decks.length ? `<div class="list">${decks.map((d) => {
      const n = d.cards.filter((c) => c.section !== 'side').reduce((s, c) => s + c.qty, 0);
      const cover = cards[(d.cards.find((c) => c.section === 'commander') || d.cards[0])?.cardId];
      const price = d.cards.reduce((s, c) => s + store.unitPrice(cards[c.cardId]) * c.qty, 0);
      return `<button class="item" data-deck="${esc(d.id)}">
        <div class="thumb">${cover?.image_small ? `<img src="${esc(cover.image_small)}" alt="">` : ''}</div>
        <div class="body"><div class="name">${esc(d.name)}</div>
          <div class="sub">${esc(d.format)} · ${n} cards · edited ${timeAgo(d.updated)}</div></div>
        <div class="right price">${money(price)}</div></button>`;
    }).join('')}</div>`
      : `<div class="empty"><div class="big">🃏</div><p>No decks yet.</p><button class="btn primary" id="d-new2">Create your first deck</button></div>`}`;
  const create = () => newDeckSheet();
  $('#d-new', el).onclick = create;
  $('#d-new2', el) && ($('#d-new2', el).onclick = create);
  $('#d-import-new', el).onclick = () => newDeckSheet(true);
  el.querySelectorAll('[data-deck]').forEach((b) => (b.onclick = () => openDeck(b.dataset.deck)));
}

function formatSelect(id, value) {
  return `<select id="${id}">${store.FORMATS.map((f) => `<option ${f === value ? 'selected' : ''}>${f}</option>`).join('')}</select>`;
}

function newDeckSheet(withImport = false) {
  const root = openSheet(`
    <h2>${withImport ? 'Import deck' : 'New deck'}</h2>
    <label class="field"><span>Name</span><input type="text" id="nd-name" placeholder="e.g. Mono-Red Burn"></label>
    <label class="field"><span>Format</span>${formatSelect('nd-format', 'Commander')}</label>
    ${withImport ? `<label class="field"><span>Decklist (one card per line: "4 Lightning Bolt")</span><textarea id="nd-list" placeholder="Commander\n1 Atraxa, Praetors' Voice\n\nDeck\n1 Sol Ring\n..."></textarea></label>` : ''}
    <button class="btn primary block" id="nd-go">${withImport ? 'Import' : 'Create deck'}</button>`);
  root.querySelector('#nd-go').onclick = async () => {
    const d = store.createDeck(root.querySelector('#nd-name').value.trim() || 'New Deck', root.querySelector('#nd-format').value);
    const text = root.querySelector('#nd-list')?.value;
    closeSheet();
    openDeck(d.id);
    if (text?.trim()) await importInto(d.id, text, false);
  };
}

/* ======================= deck editor ======================= */
function deckStats(deck) {
  const { cards } = store.state;
  const rows = deck.cards.map((c) => ({ ...c, card: cards[c.cardId] })).filter((r) => r.card);
  const count = (s) => rows.filter((r) => r.section === s).reduce((n, r) => n + r.qty, 0);
  const playing = rows.filter((r) => r.section !== 'side');

  // Mana curve (non-land, main + commander)
  const curve = Array(8).fill(0);
  for (const r of playing) if (!/Land/.test(r.card.type_line.split('//')[0])) curve[Math.min(7, Math.floor(r.card.cmc || 0))] += r.qty;

  // Color breakdown by mana symbols in costs
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const r of playing) for (const m of (r.card.mana_cost || '').matchAll(/\{([^}]+)\}/g)) {
    for (const k of Object.keys(pips)) if (m[1].includes(k)) pips[k] += r.qty;
  }
  const identity = new Set(); playing.forEach((r) => (r.card.color_identity || []).forEach((c) => identity.add(c)));

  // Prices & ownership (by card name, summed over sections)
  let total = 0, missingCost = 0, missingCards = 0;
  const need = {};
  for (const r of rows) { total += store.unitPrice(r.card) * r.qty; need[r.card.name] = (need[r.card.name] || 0) + r.qty; }
  const missing = {};
  for (const [name, n] of Object.entries(need)) {
    const short = Math.max(0, n - store.ownedCountByName(name));
    if (short) {
      missing[name] = short; missingCards += short;
      const r = rows.find((x) => x.card.name === name);
      missingCost += store.unitPrice(r.card) * short;
    }
  }
  return { rows, main: count('main'), side: count('side'), cmdr: count('commander'), curve, pips, identity, total, missing, missingCards, missingCost };
}

function renderDeck(deck) {
  const s = deckStats(deck);
  const target = TARGET(deck.format);
  const size = s.main + s.cmdr;
  const maxCurve = Math.max(1, ...s.curve);
  const pipTotal = Object.values(s.pips).reduce((a, b) => a + b, 0) || 1;
  const focused = document.activeElement?.id === 'd-add';

  el.innerHTML = `
    <div class="view-header">
      <button class="btn icon-btn ghost" id="d-back" aria-label="Back to decks">‹</button>
      <h1 class="grow" id="d-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(deck.name)}</h1>
      <button class="btn icon-btn" id="d-menu" aria-label="Deck options">⋯</button>
    </div>
    <div class="row" style="margin-bottom:10px">${formatSelect('d-format', deck.format)}</div>

    <div class="summary">
      <div class="stat"><div class="k">Cards</div><div class="v" style="color:${size === target ? 'var(--good)' : size > target ? 'var(--bad)' : 'inherit'}">${size}/${target}</div><div class="small muted">${s.side ? `+${s.side} side` : '&nbsp;'}</div></div>
      <div class="stat"><div class="k">Deck price</div><div class="v price">${money(s.total)}</div></div>
      <div class="stat"><div class="k">Not owned</div><div class="v" style="color:${s.missingCards ? 'var(--bad)' : 'var(--good)'}">${s.missingCards}</div><div class="small muted">${s.missingCards ? money(s.missingCost) + ' to buy' : 'all owned ✓'}</div></div>
    </div>

    <div class="card-panel">
      <div class="row" style="justify-content:space-between"><h3>Mana curve</h3><span class="small muted">non-land</span></div>
      <div class="curve">${s.curve.map((n, i) => `<div class="bar"><span class="n">${n || ''}</span><div class="fill" style="height:${(n / maxCurve) * 100}%"></div><span>${i === 7 ? '7+' : i}</span></div>`).join('')}</div>
      <h3 style="margin-top:14px">Colors</h3>
      <div class="colorbar">${Object.entries(s.pips).filter(([, n]) => n).map(([k, n]) => `<span style="width:${(n / pipTotal) * 100}%;background:${COLOR_VAR[k]}"></span>`).join('')}</div>
      <div class="legend">${Object.entries(s.pips).filter(([, n]) => n).map(([k, n]) => `<span><span class="dot" style="background:${COLOR_VAR[k]}"></span>${COLOR_NAMES[k]} ${Math.round((n / pipTotal) * 100)}%</span>`).join('') || '<span>No colored mana symbols yet</span>'}</div>
      ${s.identity.size ? `<div class="small muted" style="margin-top:6px">Color identity: ${[...s.identity].map((c) => `<span class="pip" style="background:${COLOR_VAR[c]}">${c}</span>`).join('')}</div>` : ''}
    </div>

    <div class="card-panel">
      <div class="seg" id="d-sec">${['main', 'side', 'commander'].map((k) => `<button data-sec="${k}" class="${addSection === k ? 'on' : ''}">${k === 'main' ? 'Main' : k === 'side' ? 'Side' : 'Commander'}</button>`).join('')}</div>
      <div class="ac-wrap" style="margin-top:8px"><input id="d-add" type="search" placeholder="Add card to ${SECTION_LABEL[addSection].toLowerCase()}…" autocomplete="off" enterkeyhint="go"></div>
      <button class="btn block" id="d-from-col" style="margin-top:8px">＋ Add from my collection</button>
    </div>

    <div id="d-cards">${sectionsHtml(deck, s)}</div>`;

  $('#d-back', el).onclick = () => { openId = null; render(); };
  $('#d-name', el).onclick = () => { const n = prompt('Rename deck', deck.name); if (n) store.updateDeck(deck.id, (d) => (d.name = n)); };
  $('#d-format', el).onchange = (e) => store.updateDeck(deck.id, (d) => (d.format = e.target.value));
  $('#d-menu', el).onclick = () => deckMenu(deck);
  $('#d-sec', el).onclick = (e) => { const b = e.target.closest('[data-sec]'); if (b) { addSection = b.dataset.sec; render(); } };
  $('#d-from-col', el).onclick = () => pickFromCollection(deck);

  const input = $('#d-add', el);
  const addByName = async (name) => {
    const card = await sf.named(name) || await sf.named(name, { fuzzy: true });
    if (!card) return toast(`No card named “${name}”`);
    store.addToDeck(deck.id, card, { section: addSection });
    toast(`+1 ${card.name}`);
    setTimeout(() => $('#d-add', el)?.focus(), 0);
  };
  attachAutocomplete(input, addByName);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) addByName(input.value.trim()); });
  if (focused) input.focus();

  $('#d-cards', el).onclick = (e) => {
    const step = e.target.closest('[data-dstep]');
    const row = e.target.closest('[data-row]');
    if (!row) return;
    const { cardid, section } = row.dataset;
    const entry = deck.cards.find((c) => c.cardId === cardid && c.section === section);
    if (!entry) return;
    if (step) return store.setDeckCardQty(deck.id, cardid, section, entry.qty + +step.dataset.dstep);
    rowMenu(deck, entry);
  };
}

function sectionsHtml(deck, s) {
  if (!s.rows.length) return `<div class="empty"><div class="big">✨</div>Add cards with the box above, from Search, Scan, or your collection.</div>`;
  const sectionRows = (sec) => s.rows.filter((r) => r.section === sec);
  const rowHtml = (r) => {
    const short = s.missing[r.card.name];
    return `<div class="item" data-row data-cardid="${esc(r.cardId)}" data-section="${r.section}" style="min-height:60px">
      <div class="thumb" style="width:38px">${r.card.image_small ? `<img loading="lazy" src="${esc(r.card.image_small)}" alt="">` : ''}</div>
      <div class="body"><div class="name">${esc(r.card.name)}</div>
        <div class="sub">${manaHtml(r.card.mana_cost)} ${short ? `<span class="badge missing">need ${short}</span>` : '<span class="badge owned">owned</span>'}</div></div>
      <div class="stepper" style="flex:none">
        <button type="button" data-dstep="-1" aria-label="Remove one">−</button><output>${r.qty}</output><button type="button" data-dstep="1" aria-label="Add one">+</button>
      </div></div>`;
  };
  let html = '';
  for (const sec of ['commander', 'main', 'side']) {
    const rows = sectionRows(sec);
    if (!rows.length) continue;
    const n = rows.reduce((a, r) => a + r.qty, 0);
    html += `<div class="section-title"><span>${SECTION_LABEL[sec]}</span><span>${n}</span></div>`;
    if (sec === 'main') {
      // Group main deck by primary type
      const groups = {};
      rows.forEach((r) => (groups[primaryType(r.card.type_line)] ||= []).push(r));
      for (const [type, rs] of Object.entries(groups).sort((a, b) => order(a[0]) - order(b[0]))) {
        rs.sort((a, b) => (a.card.cmc - b.card.cmc) || a.card.name.localeCompare(b.card.name));
        html += `<div class="small muted" style="margin:10px 2px 4px">${type} (${rs.reduce((a, r) => a + r.qty, 0)})</div><div class="list">${rs.map(rowHtml).join('')}</div>`;
      }
    } else html += `<div class="list">${rows.map(rowHtml).join('')}</div>`;
  }
  return html;
}
const order = (t) => ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land', 'Other'].indexOf(t);

function rowMenu(deck, entry) {
  const card = store.state.cards[entry.cardId];
  const root = openSheet(`
    <h2>${esc(card.name)}</h2><p class="small muted">${SECTION_LABEL[entry.section]} · ×${entry.qty} · owned ${store.ownedCountByName(card.name)}</p>
    <div class="list">
      ${['main', 'side', 'commander'].filter((s) => s !== entry.section).map((s) => `<button class="btn block" data-move="${s}">Move to ${SECTION_LABEL[s]}</button>`).join('')}
      <button class="btn block" id="rm-detail">Card details / change printing</button>
      <button class="btn block danger" id="rm-del">Remove from deck</button>
    </div>`);
  root.querySelectorAll('[data-move]').forEach((b) => (b.onclick = () => { store.moveDeckCard(deck.id, entry.cardId, entry.section, b.dataset.move); closeSheet(); }));
  root.querySelector('#rm-del').onclick = () => { store.setDeckCardQty(deck.id, entry.cardId, entry.section, 0); closeSheet(); };
  root.querySelector('#rm-detail').onclick = () => { closeSheet(); openCardSheet(card, { deckId: deck.id }); };
}

function deckMenu(deck) {
  const root = openSheet(`
    <h2>${esc(deck.name)}</h2>
    <div class="list" style="margin-top:12px">
      <button class="btn block" id="dm-export">Export decklist (text)</button>
      <button class="btn block" id="dm-import">Import / paste decklist</button>
      <button class="btn block" id="dm-addmissing">Shopping list (cards not owned)</button>
      <button class="btn block" id="dm-dup">Duplicate deck</button>
      <button class="btn block danger" id="dm-del">Delete deck</button>
    </div>`);
  root.querySelector('#dm-export').onclick = () => exportSheet(deck);
  root.querySelector('#dm-import').onclick = () => importSheet(deck);
  root.querySelector('#dm-addmissing').onclick = () => missingSheet(deck);
  root.querySelector('#dm-dup').onclick = () => {
    const d = store.createDeck(deck.name + ' (copy)', deck.format);
    store.updateDeck(d.id, (x) => (x.cards = JSON.parse(JSON.stringify(deck.cards)))); closeSheet(); openDeck(d.id);
  };
  root.querySelector('#dm-del').onclick = () => { if (confirm(`Delete “${deck.name}”?`)) { store.deleteDeck(deck.id); closeSheet(); openId = null; render(); } };
}

function exportSheet(deck) {
  let withSet = false;
  const text = () => formatDecklist(deck, store.state.cards, { withSet });
  const root = openSheet(`
    <h2>Export decklist</h2>
    <label class="switch"><input type="checkbox" id="ex-set"> Include set codes (Arena/MTGO style)</label>
    <textarea id="ex-text" readonly>${esc(text())}</textarea>
    <div class="actions"><button class="btn primary" id="ex-copy">Copy</button><button class="btn" id="ex-share">Share / Save</button></div>`);
  const ta = root.querySelector('#ex-text');
  root.querySelector('#ex-set').onchange = (e) => { withSet = e.target.checked; ta.value = text(); };
  root.querySelector('#ex-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(ta.value); toast('Copied to clipboard'); }
    catch { ta.select(); document.execCommand('copy'); toast('Copied'); }
  };
  root.querySelector('#ex-share').onclick = async () => {
    const file = `${deck.name.replace(/[^\w-]+/g, '_')}.txt`;
    if (navigator.share) { try { await navigator.share({ title: deck.name, text: ta.value }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    download(file, ta.value, 'text/plain');
  };
}

function importSheet(deck) {
  const root = openSheet(`
    <h2>Import decklist</h2>
    <p class="small muted">One card per line, e.g. <code>4 Lightning Bolt</code>. Headers like “Commander”, “Deck”, “Sideboard” and “SB:” are understood.</p>
    <textarea id="im-text" placeholder="4 Lightning Bolt\n4 Monastery Swiftspear\n20 Mountain\n\nSideboard\n2 Smash to Smithereens"></textarea>
    <label class="switch"><input type="checkbox" id="im-replace"> Replace current cards</label>
    <button class="btn primary block" id="im-go">Import</button>`);
  root.querySelector('#im-go').onclick = async () => {
    const text = root.querySelector('#im-text').value, replace = root.querySelector('#im-replace').checked;
    closeSheet();
    await importInto(deck.id, text, replace);
  };
}

/** Resolve a decklist via /cards/collection and add it to a deck. */
export async function importInto(deckId, text, replace) {
  const lines = parseDecklist(text);
  if (!lines.length) return toast('No cards found in that list');
  toast(`Looking up ${lines.length} cards…`, 10000);
  try {
    // Scryfall's collection endpoint matches split/DFC cards by front-face name only.
    const ids = lines.map((l) => { const name = l.name.split(' // ')[0].trim(); return l.set ? { name, set: l.set } : { name }; });
    let { found, notFound } = await sf.collection(ids);
    // Retry set-specific misses by name only
    const retry = notFound.filter((n) => n.set).map((n) => ({ name: n.name }));
    if (retry.length) { const r2 = await sf.collection(retry); found.push(...r2.found); notFound = notFound.filter((n) => !n.set).concat(r2.notFound); }
    const byName = new Map();
    for (const c of found) {
      byName.set(c.name.toLowerCase(), c);
      byName.set(c.name.split(' // ')[0].toLowerCase(), c);
    }
    const deck = store.getDeck(deckId);
    if (replace) store.updateDeck(deckId, (d) => (d.cards = []));
    let added = 0;
    for (const l of lines) {
      const c = byName.get(l.name.toLowerCase()) || byName.get(l.name.split(' // ')[0].toLowerCase());
      if (!c) continue;
      store.addToDeck(deckId, c, { qty: l.qty, section: l.section }); added += l.qty;
    }
    const miss = notFound.map((n) => n.name).filter(Boolean);
    toast(`Imported ${added} cards${miss.length ? ` · not found: ${miss.slice(0, 3).join(', ')}${miss.length > 3 ? '…' : ''}` : ''}`, miss.length ? 6000 : 2500);
  } catch (e) {
    toast('Import failed: ' + e.message, 4000);
  }
}

function missingSheet(deck) {
  const s = deckStats(deck);
  const lines = Object.entries(s.missing).map(([n, q]) => `${q} ${n}`).join('\n');
  const root = openSheet(`
    <h2>Cards you don't own</h2>
    <p class="small muted">${s.missingCards} cards · about ${money(s.missingCost)} at TCGplayer market</p>
    <textarea readonly id="ms-text">${esc(lines || 'You own everything in this deck 🎉')}</textarea>
    <button class="btn primary block" id="ms-copy" style="margin-top:8px">Copy list</button>`);
  root.querySelector('#ms-copy').onclick = () => navigator.clipboard?.writeText(lines).then(() => toast('Copied'), () => toast('Copy failed'));
}

/** Sheet listing the collection; tap a card to add one copy to the deck. */
function pickFromCollection(deck) {
  const { collection, cards } = store.state;
  if (!collection.length) return toast('Your collection is empty');
  const root = openSheet(`
    <h2>Add from collection</h2>
    <p class="small muted">Adds to: <b>${SECTION_LABEL[addSection]}</b>. Tap to add one copy.</p>
    <input type="search" id="pc-filter" placeholder="Filter…" style="margin-bottom:8px">
    <div class="list" id="pc-list"></div>`);
  const list = root.querySelector('#pc-list');
  const draw = (t = '') => {
    const seen = new Set();
    const rows = collection.map((e) => cards[e.cardId]).filter((c) => c && !seen.has(c.name) && seen.add(c.name) && c.name.toLowerCase().includes(t.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
    list.innerHTML = rows.map((c) => `<button class="item" data-pc="${esc(c.id)}" style="min-height:56px">
      <div class="thumb" style="width:34px">${c.image_small ? `<img loading="lazy" src="${esc(c.image_small)}" alt="">` : ''}</div>
      <div class="body"><div class="name">${esc(c.name)}</div><div class="sub">owned ${store.ownedCountByName(c.name)} · in deck ${deck.cards.filter((x) => cards[x.cardId]?.name === c.name).reduce((a, x) => a + x.qty, 0)}</div></div>
      <div class="right">＋</div></button>`).join('') || '<div class="empty">No matches</div>';
  };
  draw();
  root.querySelector('#pc-filter').oninput = (e) => draw(e.target.value);
  list.onclick = (e) => {
    const b = e.target.closest('[data-pc]'); if (!b) return;
    store.addToDeck(deck.id, cards[b.dataset.pc], { section: addSection });
    toast(`+1 ${cards[b.dataset.pc].name}`);
    draw(root.querySelector('#pc-filter').value);
  };
}
