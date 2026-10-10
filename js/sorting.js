/**
 * sorting.js — sort comparators + filters shared by collection & deck views.
 */
import { COLOR_ORDER, RARITY_ORDER } from './ui.js';

const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land'];

export function primaryType(typeLine = '') {
  const front = typeLine.split('//')[0];
  for (const t of TYPE_ORDER) if (front.includes(t)) return t;
  return 'Other';
}

/** Numeric "color group" for sorting: W,U,B,R,G mono → 0..4, multi 5, colorless 6. */
export function colorKey(card) {
  const c = card.colors?.length ? card.colors : [];
  if (c.length === 0) return 6;
  if (c.length > 1) return 5;
  return COLOR_ORDER.indexOf(c[0]);
}

export const SORTS = {
  name: { label: 'Name', fn: (a, b) => a.card.name.localeCompare(b.card.name) },
  price: { label: 'Price', fn: (a, b) => a.price - b.price },
  value: { label: 'Total value', fn: (a, b) => a.price * a.qty - b.price * b.qty },
  color: { label: 'Color', fn: (a, b) => colorKey(a.card) - colorKey(b.card) },
  type: { label: 'Type', fn: (a, b) => TYPE_ORDER.indexOf(primaryType(a.card.type_line)) - TYPE_ORDER.indexOf(primaryType(b.card.type_line)) },
  rarity: { label: 'Rarity', fn: (a, b) => (RARITY_ORDER[a.card.rarity] ?? 9) - (RARITY_ORDER[b.card.rarity] ?? 9) },
  set: { label: 'Set', fn: (a, b) => (a.card.set_name || '').localeCompare(b.card.set_name || '') || (parseInt(a.card.collector_number) || 0) - (parseInt(b.card.collector_number) || 0) },
  cmc: { label: 'Mana value', fn: (a, b) => (a.card.cmc || 0) - (b.card.cmc || 0) },
  added: { label: 'Date added', fn: (a, b) => (a.added || '').localeCompare(b.added || '') },
};

/**
 * rows: [{ card, qty, price, added, ... }]
 * opts: { sort, dir: 1|-1, text, colors:Set, rarities:Set }
 */
export function applySortFilter(rows, { sort = 'name', dir = 1, text = '', colors = new Set(), rarities = new Set() }) {
  const t = text.trim().toLowerCase();
  let out = rows.filter(({ card }) => {
    if (t && !`${card.name} ${card.type_line} ${card.set} ${card.set_name} ${card.oracle_text || ''}`.toLowerCase().includes(t)) return false;
    if (colors.size) {
      const cs = card.colors || [];
      const ok = [...colors].some((c) => (c === 'C' ? cs.length === 0 : c === 'M' ? cs.length > 1 : cs.includes(c)));
      if (!ok) return false;
    }
    if (rarities.size && !rarities.has(card.rarity)) return false;
    return true;
  });
  const cmp = SORTS[sort]?.fn || SORTS.name.fn;
  out.sort((a, b) => dir * cmp(a, b) || a.card.name.localeCompare(b.card.name));
  return out;
}
