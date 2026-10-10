/**
 * sw.js — service worker.
 *  - Precaches the app shell so the app opens offline.
 *  - Same-origin files: stale-while-revalidate (fast, and updates in background).
 *  - OCR engine (vendor/tesseract/*): cache-first, cached on first scanner use.
 *  - Card images (cards.scryfall.io): cache-first, capped at MAX_IMAGES.
 *  - Scryfall API: always network (prices must be fresh).
 *  - Supabase (*.supabase.co) and any other cross-origin API: not intercepted.
 * Bump VERSION when you change shell files to force clients to update.
 */
const VERSION = 'v3';
const SHELL = `shell-${VERSION}`;
const RUNTIME = 'runtime-v1';
const IMAGES = 'images-v1';
const MAX_IMAGES = 600;

const SHELL_FILES = [
  './', 'index.html', 'manifest.json', 'css/styles.css',
  'js/app.js', 'js/store.js', 'js/scryfall.js', 'js/ui.js', 'js/cardsheet.js', 'js/sorting.js',
  'js/decklist.js', 'js/ocr.js', 'js/names.js', 'js/config.js', 'js/sync.js', 'js/synccore.js', 'js/views/account.js',
  'js/views/search.js', 'js/views/scanner.js', 'js/views/collection.js', 'js/views/decks.js', 'js/views/settings.js',
  'vendor/supabase.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trimCache(name, max) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Scryfall API → network only.
  if (url.hostname === 'api.scryfall.com') return;

  // Card images → cache first.
  if (url.hostname.endsWith('scryfall.io')) {
    e.respondWith((async () => {
      const c = await caches.open(IMAGES);
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); trimCache(IMAGES, MAX_IMAGES); }
      return res;
    })());
    return;
  }

  if (url.origin !== location.origin) return;

  // OCR engine → cache first (large, versioned files).
  if (url.pathname.includes('/vendor/')) {
    e.respondWith((async () => {
      const hit = await caches.match(req); // any cache (supabase.js is precached in the shell)
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone());
      return res;
    })());
    return;
  }

  // App shell → stale-while-revalidate (navigation falls back to index.html).
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const hit = await c.match(key, { ignoreSearch: req.mode === 'navigate' });
    const net = fetch(req).then((res) => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('Offline', { status: 503 });
  })());
});
