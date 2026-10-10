/**
 * app.js — entry point: loads state, mounts views, handles tab navigation,
 * re-renders on state changes and registers the service worker.
 *
 * Adding a new tab: create js/views/<name>.js exporting mount(el) (and
 * optionally render/show/hide), add a <section id="view-<name>"> and a tab
 * button in index.html, and register it in VIEWS below.
 */
import * as store from './store.js';
import { $, $$, sheetOpen } from './ui.js';
import * as search from './views/search.js';
import * as scanner from './views/scanner.js';
import * as collection from './views/collection.js';
import * as decks from './views/decks.js';
import * as settings from './views/settings.js';

const VIEWS = { search, scan: scanner, collection, decks, settings };
let active = 'search';

function show(tab) {
  if (!VIEWS[tab]) tab = 'search';
  if (active !== tab) VIEWS[active].hide?.();
  active = tab;
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== tab));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  VIEWS[tab].render?.();
  VIEWS[tab].show?.();
  if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  window.scrollTo(0, 0);
}

async function init() {
  await store.load();
  for (const [name, view] of Object.entries(VIEWS)) view.mount($(`#view-${name}`));
  $$('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  // Re-render the visible view whenever state changes (cheap: views are small).
  store.subscribe(() => VIEWS[active].render?.());
  show(location.hash.slice(1) || 'search');
}

// Remember the Android/desktop install prompt so Settings can offer a button.
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); window.__installPrompt = e; });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  });
}

init();
