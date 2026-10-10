/**
 * scryfall.js — thin, rate-limited client for https://api.scryfall.com
 *
 * Scryfall asks for <= 10 requests/second; all calls go through a single
 * queue spaced ~120 ms apart. Prices come from Scryfall's `prices` object:
 * `usd` / `usd_foil` are TCGplayer market prices (updated ~daily).
 */

const API = 'https://api.scryfall.com';
const MIN_GAP_MS = 120;

let last = 0;
let chain = Promise.resolve();

/** Queue a fetch so requests never exceed the rate limit. */
function throttled(url, opts = {}) {
  const run = async () => {
    const wait = Math.max(0, last + MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fetch(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

async function getJSON(path, opts) {
  const res = await throttled(API + path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.details || `Scryfall error ${res.status}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

/** Reduce a full Scryfall card object to what we store. */
export function slim(c) {
  const face = c.card_faces?.[0] || {};
  const img = c.image_uris || face.image_uris || {};
  const colors = c.colors ?? face.colors ?? [];
  return {
    id: c.id,
    oracle_id: c.oracle_id ?? face.oracle_id,
    name: c.name,
    set: c.set,
    set_name: c.set_name,
    collector_number: c.collector_number,
    rarity: c.rarity,
    type_line: c.type_line ?? face.type_line ?? '',
    mana_cost: c.mana_cost ?? (c.card_faces ? c.card_faces.map((f) => f.mana_cost).filter(Boolean).join(' // ') : ''),
    cmc: c.cmc ?? 0,
    colors,
    color_identity: c.color_identity || [],
    oracle_text: c.oracle_text ?? (c.card_faces ? c.card_faces.map((f) => f.oracle_text).join('\n—\n') : ''),
    image: img.normal || img.large || '',
    image_small: img.small || img.normal || '',
    released_at: c.released_at,
    finishes: c.finishes || [],
    prices: { usd: c.prices?.usd ?? null, usd_foil: c.prices?.usd_foil ?? c.prices?.usd_etched ?? null },
    tcgplayer: c.purchase_uris?.tcgplayer || null,
    scryfall_uri: c.scryfall_uri,
    fetched: new Date().toISOString(),
  };
}

export async function autocomplete(q) {
  if (!q || q.length < 2) return [];
  const r = await getJSON(`/cards/autocomplete?q=${encodeURIComponent(q)}`);
  return r.data || [];
}

/** Full-text Scryfall search (supports Scryfall syntax, e.g. "t:dragon c:r"). */
export async function search(q, { unique = 'cards', order = 'name', page = 1 } = {}) {
  try {
    const r = await getJSON(`/cards/search?q=${encodeURIComponent(q)}&unique=${unique}&order=${order}&page=${page}`);
    return { cards: r.data.map(slim), hasMore: r.has_more, total: r.total_cards };
  } catch (e) {
    if (e.status === 404) return { cards: [], hasMore: false, total: 0 };
    throw e;
  }
}

/** Exact or fuzzy single-card lookup. Returns slim card or null. */
export async function named(name, { fuzzy = false, set } = {}) {
  try {
    const qs = `${fuzzy ? 'fuzzy' : 'exact'}=${encodeURIComponent(name)}${set ? `&set=${encodeURIComponent(set)}` : ''}`;
    return slim(await getJSON(`/cards/named?${qs}`));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** All printings of a card name, newest first. */
export async function printings(name) {
  const q = `!"${name.replace(/"/g, '')}" include:extras`;
  const all = [];
  let page = 1, more = true;
  while (more && page <= 4) {
    const r = await search(q, { unique: 'prints', order: 'released', page });
    all.push(...r.cards); more = r.hasMore; page++;
  }
  // Newest first; ties broken by collector number.
  return all.sort((a, b) => (b.released_at || '').localeCompare(a.released_at || '') || (parseInt(a.collector_number) || 0) - (parseInt(b.collector_number) || 0));
}

/**
 * Batch lookup via POST /cards/collection (max 75 identifiers per request).
 * identifiers: [{id}] or [{name}] or [{name, set}] ...
 * Returns { found: SlimCard[], notFound: identifier[] }.
 */
export async function collection(identifiers, onProgress) {
  const found = [], notFound = [];
  for (let i = 0; i < identifiers.length; i += 75) {
    const batch = identifiers.slice(i, i + 75);
    const r = await getJSON('/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: batch }),
    });
    found.push(...r.data.map(slim));
    notFound.push(...(r.not_found || []));
    onProgress?.(Math.min(i + 75, identifiers.length), identifiers.length);
  }
  return { found, notFound };
}
