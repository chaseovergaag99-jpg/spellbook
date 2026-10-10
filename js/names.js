/**
 * names.js — local fuzzy matching against Scryfall's full card-name catalog.
 *
 * The scanner uses this to turn noisy OCR text ("onovareves Elves") into a
 * real card name without hammering the API. The catalog
 * (GET /catalog/card-names, ~35k names) is downloaded once, kept in
 * IndexedDB and refreshed weekly.
 *
 * Similarity = Dice coefficient on character bigrams (fast, typo-tolerant).
 */
import { idbGet, idbSet } from './store.js';

const KEY = 'catalog:card-names';
const MAX_AGE = 7 * 24 * 3600 * 1000;
let names = null;     // [{ name, norm, grams:Set }]
let loading = null;

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
function bigrams(s) {
  const g = new Set(); const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}
function dice(a, b) {
  let n = 0; for (const x of a) if (b.has(x)) n++;
  return (2 * n) / (a.size + b.size || 1);
}

function index(list) {
  names = list.map((name) => {
    const front = name.split(' // ')[0];
    const n = norm(front);
    return { name, norm: n, grams: bigrams(n) };
  });
}

/** Load the catalog (from IndexedDB, else network). Resolves to true when ready. */
export function loadCatalog() {
  if (names) return Promise.resolve(true);
  if (!loading) loading = (async () => {
    let cached = null;
    try { cached = await idbGet(KEY); } catch {}
    if (cached && Date.now() - cached.t < MAX_AGE) { index(cached.data); return true; }
    try {
      const res = await fetch('https://api.scryfall.com/catalog/card-names', { headers: { Accept: 'application/json' } });
      const json = await res.json();
      index(json.data);
      idbSet(KEY, { t: Date.now(), data: json.data }).catch(() => {});
      return true;
    } catch (e) {
      if (cached) { index(cached.data); return true; }
      loading = null; return false;
    }
  })();
  return loading;
}
export const catalogReady = () => !!names;

/** Best catalog matches for a piece of text: [{ name, score }] (score 0..1). */
export function bestMatches(text, n = 6) {
  if (!names) return [];
  const q = norm(text); if (q.length < 3) return [];
  const qg = bigrams(q);
  const top = [];
  for (const e of names) {
    // quick length filter
    if (Math.abs(e.norm.length - q.length) > Math.max(6, q.length * 0.6)) continue;
    const s = dice(qg, e.grams);
    if (top.length < n || s > top[top.length - 1].score) {
      top.push({ name: e.name, score: s });
      top.sort((a, b) => b.score - a.score);
      if (top.length > n) top.pop();
    }
  }
  return top;
}
