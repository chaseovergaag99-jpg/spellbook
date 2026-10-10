/**
 * store.js — app state + persistence (IndexedDB, falls back to localStorage).
 *
 * Shape of the persisted state:
 * {
 *   version: 1,
 *   cards: { [scryfallId]: SlimCard },          // shared card cache (prices live here)
 *   collection: [ { uid, cardId, qty, foil, condition, added } ],
 *   decks: [ { id, name, format, created, updated,
 *              cards: [ { cardId, qty, section: 'main'|'side'|'commander' } ] } ],
 *   meta: { lastRefresh: ISOString|null, lastRefreshTotal: number|null }
 * }
 *
 * SlimCard is produced by scryfall.slim() — see that file for fields.
 * Every mutation should go through the helpers below (or call save()) so the
 * state is persisted and subscribers re-render.
 */

const DB_NAME = 'spellbook';
const STORE = 'kv';
const KEY = 'state';

export const state = {
  version: 1,
  cards: {},
  collection: [],
  decks: [],
  meta: { lastRefresh: null, lastRefreshTotal: null },
};

/* ---------- IndexedDB key/value helpers ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function idbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
export async function idbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

/* ---------- load / save ---------- */
export async function load() {
  let saved = null;
  try { saved = await idbGet(KEY); } catch (e) { console.warn('IDB unavailable, using localStorage', e); }
  if (!saved) {
    try { saved = JSON.parse(localStorage.getItem(DB_NAME + ':' + KEY) || 'null'); } catch {}
  }
  if (saved) replaceState(saved, false);
  // Ask the browser not to evict our data (best-effort; mainly matters on iOS/Safari).
  navigator.storage?.persist?.().catch(() => {});
}

let saveTimer = null;
/** Persist (debounced) and notify subscribers. */
export function save() {
  emit();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
}
export async function flush() {
  clearTimeout(saveTimer);
  const snapshot = JSON.parse(JSON.stringify(state));
  try { await idbSet(KEY, snapshot); }
  catch (e) {
    try { localStorage.setItem(DB_NAME + ':' + KEY, JSON.stringify(snapshot)); }
    catch (e2) { console.error('Could not save state', e2); }
  }
}
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());

export function replaceState(next, persist = true) {
  state.cards = next.cards || {};
  state.collection = next.collection || [];
  state.decks = next.decks || [];
  state.meta = { lastRefresh: null, lastRefreshTotal: null, ...(next.meta || {}) };
  if (persist) save();
}

/* ---------- pub/sub so views re-render on change ---------- */
const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); }

/* ---------- helpers ---------- */
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/** Store/refresh a slim card in the shared cache, keeping previous-price history. */
export function upsertCard(slim) {
  const old = state.cards[slim.id];
  state.cards[slim.id] = { ...slim, prev: old?.prev ?? null };
  return slim.id;
}

/** Unit price for a card (foil-aware), as a number (0 when unknown). */
export function unitPrice(card, foil) {
  if (!card) return 0;
  const p = foil ? (card.prices.usd_foil ?? card.prices.usd) : (card.prices.usd ?? card.prices.usd_foil);
  return p ? parseFloat(p) : 0;
}
export function prevUnitPrice(card, foil) {
  if (!card?.prev) return null;
  const p = foil ? (card.prev.usd_foil ?? card.prev.usd) : (card.prev.usd ?? card.prev.usd_foil);
  return p ? parseFloat(p) : null;
}

/* ----- collection ----- */
export function addToCollection(card, { qty = 1, foil = false, condition = 'NM' } = {}) {
  upsertCard(card);
  // Merge with an identical existing row (same printing + finish + condition).
  const existing = state.collection.find((e) => e.cardId === card.id && e.foil === foil && e.condition === condition);
  if (existing) existing.qty += qty;
  else state.collection.unshift({ uid: uid(), cardId: card.id, qty, foil, condition, added: new Date().toISOString() });
  save();
}
export function updateEntry(entryUid, patch) {
  const e = state.collection.find((x) => x.uid === entryUid);
  if (e) Object.assign(e, patch);
  if (e && e.qty <= 0) removeEntry(entryUid); else save();
}
export function removeEntry(entryUid) {
  state.collection = state.collection.filter((x) => x.uid !== entryUid);
  save();
}
/** How many copies of a card *name* the user owns (any printing). */
export function ownedCountByName(name) {
  let n = 0;
  for (const e of state.collection) if (state.cards[e.cardId]?.name === name) n += e.qty;
  return n;
}
export function collectionValue() {
  let total = 0, prev = 0, hasPrev = false;
  for (const e of state.collection) {
    const c = state.cards[e.cardId];
    total += unitPrice(c, e.foil) * e.qty;
    const p = prevUnitPrice(c, e.foil);
    if (p != null) { prev += p * e.qty; hasPrev = true; } else prev += unitPrice(c, e.foil) * e.qty;
  }
  return { total, delta: hasPrev ? total - prev : null };
}

/* ----- decks ----- */
export const FORMATS = ['Commander', 'Standard', 'Modern', 'Pioneer', 'Legacy', 'Vintage', 'Pauper', 'Brawl', 'Historic', 'Limited', 'Casual'];
export function createDeck(name, format) {
  const d = { id: uid(), name: name || 'New Deck', format: format || 'Commander', created: new Date().toISOString(), updated: new Date().toISOString(), cards: [] };
  state.decks.unshift(d);
  save();
  return d;
}
export function getDeck(id) { return state.decks.find((d) => d.id === id); }
export function deleteDeck(id) { state.decks = state.decks.filter((d) => d.id !== id); save(); }
export function addToDeck(deckId, card, { qty = 1, section = 'main' } = {}) {
  const d = getDeck(deckId); if (!d) return;
  upsertCard(card);
  // Merge by name+section so different printings of the same card stack.
  const ex = d.cards.find((c) => c.section === section && (c.cardId === card.id || state.cards[c.cardId]?.name === card.name));
  if (ex) ex.qty += qty; else d.cards.push({ cardId: card.id, qty, section });
  d.updated = new Date().toISOString();
  save();
}
export function setDeckCardQty(deckId, cardId, section, qty) {
  const d = getDeck(deckId); if (!d) return;
  const c = d.cards.find((x) => x.cardId === cardId && x.section === section);
  if (!c) return;
  c.qty = qty;
  if (qty <= 0) d.cards = d.cards.filter((x) => x !== c);
  d.updated = new Date().toISOString();
  save();
}
export function moveDeckCard(deckId, cardId, from, to) {
  const d = getDeck(deckId); if (!d) return;
  const c = d.cards.find((x) => x.cardId === cardId && x.section === from);
  if (!c) return;
  const target = d.cards.find((x) => x.cardId === cardId && x.section === to);
  if (target) { target.qty += c.qty; d.cards = d.cards.filter((x) => x !== c); } else c.section = to;
  save();
}

/** Drop cached cards that nothing references anymore (keeps backups small). */
export function pruneCards() {
  const used = new Set(state.collection.map((e) => e.cardId));
  state.decks.forEach((d) => d.cards.forEach((c) => used.add(c.cardId)));
  for (const id of Object.keys(state.cards)) if (!used.has(id)) delete state.cards[id];
}
