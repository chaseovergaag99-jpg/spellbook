/** Unit tests for js/synccore.js (pure merge logic). Run: node sync-unit-test.mjs */
import assert from 'node:assert/strict';
import * as core from '../js/synccore.js';

const blank = () => ({ cards: {}, collection: [], decks: [], tombstones: { collection: {}, decks: {} }, sync: { userId: 'u', cursor: {}, dirty: { collection: {}, decks: {} } } });
const card = { id: 'c1', name: 'Bolt', prices: { usd: '1' }, fetched: '2026-01-01T00:00:00.000Z', prev: { usd: '0.5' } };
let n = 0; const t = (name, fn) => { fn(); n++; console.log('✓', name); };

t('entryToRow strips device-only price history', () => {
  const s = blank(); s.cards.c1 = card;
  const row = core.entryToRow({ uid: 'e1', cardId: 'c1', qty: 2, foil: true, updated: '2026-01-02T00:00:00.000Z' }, s, 'u');
  assert.equal(row.card.prev, undefined); assert.equal(row.user_id, 'u'); assert.equal(row.qty, 2);
});
t('remote newer (server "+00:00" format) overwrites local', () => {
  const s = blank(); s.collection.push({ uid: 'e1', cardId: 'c1', qty: 1, updated: '2026-01-01T00:00:00.000Z' }); s.sync.dirty.collection.e1 = 'x';
  const n = core.applyRemote(s, 'collection', [{ id: 'e1', card_id: 'c1', card, qty: 5, updated_at: '2026-01-01T00:00:01+00:00', deleted: false }]);
  assert.equal(n, 1); assert.equal(s.collection[0].qty, 5); assert.equal(s.sync.dirty.collection.e1, undefined);
});
t('local newer wins and is re-queued', () => {
  const s = blank(); s.collection.push({ uid: 'e1', cardId: 'c1', qty: 9, updated: '2026-01-03T00:00:00.000Z' });
  core.applyRemote(s, 'collection', [{ id: 'e1', card_id: 'c1', qty: 5, updated_at: '2026-01-02T00:00:00+00:00', deleted: false }]);
  assert.equal(s.collection[0].qty, 9); assert.ok(s.sync.dirty.collection.e1);
});
t('remote soft delete removes local + leaves tombstone', () => {
  const s = blank(); s.collection.push({ uid: 'e1', cardId: 'c1', qty: 1, updated: '2026-01-01T00:00:00.000Z' });
  core.applyRemote(s, 'collection', [{ id: 'e1', deleted: true, updated_at: '2026-01-02T00:00:00Z' }]);
  assert.equal(s.collection.length, 0); assert.equal(s.tombstones.collection.e1, '2026-01-02T00:00:00Z');
});
t('older remote row does not resurrect a locally deleted record', () => {
  const s = blank(); s.tombstones.decks.d1 = '2026-01-05T00:00:00.000Z';
  core.applyRemote(s, 'decks', [{ id: 'd1', name: 'Old', cards: [], updated_at: '2026-01-04T00:00:00Z', deleted: false }]);
  assert.equal(s.decks.length, 0); assert.ok(s.sync.dirty.decks.d1);
});
t('newer remote row resurrects over an older tombstone', () => {
  const s = blank(); s.tombstones.decks.d1 = '2026-01-01T00:00:00.000Z';
  core.applyRemote(s, 'decks', [{ id: 'd1', name: 'Back', format: 'Modern', cards: [{ cardId: 'c1', qty: 4, section: 'main' }], card_data: { c1: card }, updated_at: '2026-01-02T00:00:00Z', deleted: false }]);
  assert.equal(s.decks[0].name, 'Back'); assert.equal(s.tombstones.decks.d1, undefined); assert.equal(s.cards.c1.name, 'Bolt');
});
t('card snapshot only replaces local if fresher; local price history kept', () => {
  const s = blank(); s.cards.c1 = { ...card, fetched: '2026-02-01T00:00:00.000Z', prices: { usd: '3' } };
  core.applyRemote(s, 'collection', [{ id: 'e1', card_id: 'c1', card: { ...card, prices: { usd: '1' } }, qty: 1, updated_at: '2026-01-02T00:00:00Z' }]);
  assert.equal(s.cards.c1.prices.usd, '3');
  core.applyRemote(s, 'collection', [{ id: 'e2', card_id: 'c1', card: { ...card, fetched: '2026-03-01T00:00:00.000Z', prices: { usd: '4' } }, qty: 1, updated_at: '2026-01-02T00:00:00Z' }]);
  assert.equal(s.cards.c1.prices.usd, '4'); assert.deepEqual(s.cards.c1.prev, { usd: '0.5' });
});
t('collectDirty emits rows + tombstones; deck tombstones carry non-null jsonb', () => {
  const s = blank(); s.cards.c1 = card;
  s.collection.push({ uid: 'e1', cardId: 'c1', qty: 1, updated: 'T1' }); s.sync.dirty.collection.e1 = 'T1';
  s.tombstones.decks.d9 = 'T2'; s.sync.dirty.decks.d9 = 'T2';
  const out = core.collectDirty(s, 'u');
  assert.equal(out.collection_items.length, 1); assert.equal(out.decks[0].deleted, true); assert.deepEqual(out.decks[0].cards, []);
});
t('clearPushed keeps records edited during the upload', () => {
  const s = blank(); s.sync.dirty.collection = { a: 'T1', b: 'T1' };
  const marks = { collection: { a: 'T1', b: 'T1' }, decks: {} };
  s.sync.dirty.collection.b = 'T2'; // edited mid-push
  core.clearPushed(s, marks);
  assert.deepEqual(s.sync.dirty.collection, { b: 'T2' });
});
t('markAllDirty queues records and tombstones (first sign-in merge)', () => {
  const s = blank(); s.collection.push({ uid: 'e1', updated: 'T1' }); s.decks.push({ id: 'd1', updated: 'T2', cards: [] }); s.tombstones.collection.e0 = 'T0';
  core.markAllDirty(s);
  assert.deepEqual(s.sync.dirty, { collection: { e1: 'T1', e0: 'T0' }, decks: { d1: 'T2' } });
});
t('advanceCursor picks the latest synced_at', () => {
  assert.equal(core.advanceCursor(null, [{ synced_at: '2026-01-01T00:00:00.5+00:00' }, { synced_at: '2026-01-01T00:00:01+00:00' }]), '2026-01-01T00:00:01+00:00');
  assert.equal(core.advanceCursor('2026-02-01T00:00:00Z', []), '2026-02-01T00:00:00Z');
});
console.log(`\n${n} unit tests passed`);
