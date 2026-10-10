/**
 * synccore.js — pure, DOM-free sync logic (unit-tested in dev/sync-test.mjs).
 *
 * Model: the device's local state is the source of truth. Each collection
 * entry / deck has an `updated` timestamp; deletions leave a tombstone.
 * Remote rows (Supabase) carry `updated_at`, `deleted`, and a server-set
 * `synced_at` used as the pull cursor.
 *
 *  pull:  rows with synced_at >= cursor  → applyRemote() (last-write-wins)
 *  push:  collectDirty() → upsert rows   → clearPushed()
 *
 * On first sign-in on a device (or a different user), markAllDirty() queues
 * every local record so local + cloud data are merged without losing either.
 */

export const TABLES = { collection: 'collection_items', decks: 'decks' };
const ms = (t) => (t ? Date.parse(t) : 0);

/** Strip device-only fields (price history) from a card snapshot. */
function snap(card) {
  if (!card) return null;
  const { prev, ...rest } = card;
  return rest;
}

/* ---------------- local → rows ---------------- */
export function entryToRow(e, state, userId) {
  return {
    user_id: userId, id: e.uid, deleted: false, updated_at: e.updated,
    card_id: e.cardId, card: snap(state.cards[e.cardId]),
    qty: e.qty, foil: !!e.foil, condition: e.condition || 'NM', added_at: e.added || e.updated,
  };
}
export function deckToRow(d, state, userId) {
  const card_data = {};
  for (const c of d.cards) if (state.cards[c.cardId]) card_data[c.cardId] = snap(state.cards[c.cardId]);
  return {
    user_id: userId, id: d.id, deleted: false, updated_at: d.updated,
    name: d.name, format: d.format, created_at: d.created || d.updated,
    cards: d.cards.map(({ cardId, qty, section }) => ({ cardId, qty, section })), card_data,
  };
}
const tombRow = (id, t, userId) => ({ user_id: userId, id, deleted: true, updated_at: t });

/**
 * Rows to push for everything marked dirty.
 * Returns { collection_items: Row[], decks: Row[], marks } — pass `marks`
 * to clearPushed() after a successful upload.
 */
export function collectDirty(state, userId) {
  const out = { collection_items: [], decks: [], marks: { collection: {}, decks: {} } };
  for (const [id, mark] of Object.entries(state.sync.dirty.collection)) {
    const e = state.collection.find((x) => x.uid === id);
    if (e) out.collection_items.push(entryToRow(e, state, userId));
    else if (state.tombstones.collection[id]) out.collection_items.push(tombRow(id, state.tombstones.collection[id], userId));
    out.marks.collection[id] = mark;
  }
  for (const [id, mark] of Object.entries(state.sync.dirty.decks)) {
    const d = state.decks.find((x) => x.id === id);
    if (d) out.decks.push(deckToRow(d, state, userId));
    else if (state.tombstones.decks[id]) out.decks.push({ ...tombRow(id, state.tombstones.decks[id], userId), cards: [], card_data: {} });
    out.marks.decks[id] = mark;
  }
  return out;
}

/** Clear dirty flags for pushed records — unless they changed again meanwhile. */
export function clearPushed(state, marks) {
  for (const kind of ['collection', 'decks']) {
    for (const [id, mark] of Object.entries(marks[kind])) {
      if (state.sync.dirty[kind][id] === mark) delete state.sync.dirty[kind][id];
    }
  }
}

/** Queue every local record (and tombstone) for upload. */
export function markAllDirty(state) {
  for (const e of state.collection) state.sync.dirty.collection[e.uid] = e.updated;
  for (const d of state.decks) state.sync.dirty.decks[d.id] = d.updated;
  for (const [id, t] of Object.entries(state.tombstones.collection)) state.sync.dirty.collection[id] = t;
  for (const [id, t] of Object.entries(state.tombstones.decks)) state.sync.dirty.decks[id] = t;
}

/* ---------------- rows → local ---------------- */
function mergeCard(state, card) {
  if (!card?.id) return;
  const local = state.cards[card.id];
  // Keep whichever snapshot has the fresher prices; never drop local price history.
  if (!local || ms(card.fetched) > ms(local.fetched)) state.cards[card.id] = { ...card, prev: local?.prev ?? null };
}

/**
 * Apply pulled rows with last-write-wins on updated_at.
 * kind: 'collection' | 'decks'. Returns number of local changes.
 */
export function applyRemote(state, kind, rows) {
  let changed = 0;
  const list = kind === 'collection' ? state.collection : state.decks;
  const key = kind === 'collection' ? 'uid' : 'id';
  for (const row of rows) {
    const idx = list.findIndex((x) => x[key] === row.id);
    const local = idx >= 0 ? list[idx] : null;
    const localT = local ? ms(local.updated) : ms(state.tombstones[kind][row.id]);
    const remoteT = ms(row.updated_at);
    if (localT && localT >= remoteT) {
      // Local is newer (or same): make sure it gets (re)pushed if strictly newer.
      if (localT > remoteT && !state.sync.dirty[kind][row.id]) state.sync.dirty[kind][row.id] = local ? local.updated : state.tombstones[kind][row.id];
      continue;
    }
    // Remote wins.
    changed++;
    delete state.sync.dirty[kind][row.id];
    if (row.deleted) {
      if (idx >= 0) list.splice(idx, 1);
      state.tombstones[kind][row.id] = row.updated_at;
      continue;
    }
    delete state.tombstones[kind][row.id];
    let rec;
    if (kind === 'collection') {
      mergeCard(state, row.card);
      rec = { uid: row.id, cardId: row.card_id, qty: row.qty, foil: !!row.foil, condition: row.condition || 'NM', added: row.added_at, updated: row.updated_at };
    } else {
      Object.values(row.card_data || {}).forEach((c) => mergeCard(state, c));
      rec = { id: row.id, name: row.name, format: row.format, created: row.created_at, updated: row.updated_at, cards: (row.cards || []).map((c) => ({ ...c })) };
    }
    if (idx >= 0) list[idx] = rec; else list.unshift(rec);
  }
  return changed;
}

/** Highest synced_at among rows (string as returned by the server), or the old cursor. */
export function advanceCursor(cursor, rows) {
  let best = cursor;
  for (const r of rows) if (r.synced_at && (!best || ms(r.synced_at) > ms(best))) best = r.synced_at;
  return best;
}
