/**
 * views/settings.js — backup export/import (JSON), storage info, install help.
 */
import * as store from '../store.js';
import { $, toast, download, timeAgo, money } from '../ui.js';
import { refreshPrices } from './collection.js';
import * as account from './account.js';
import * as sync from '../sync.js';

let el;
export function mount(root) { el = root; render(); }

export function render(force = false) {
  if (!el) return;
  // Don't wipe a half-typed sign-in form or the "check your inbox" screen on unrelated re-renders.
  if (!force && !sync.getUser()) {
    const typing = el.querySelector('#acct-form') && el.contains(document.activeElement) && /INPUT/.test(document.activeElement.tagName);
    if (typing || el.querySelector('#acct-confirm')) return;
  }
  const { collection, decks, cards, meta } = store.state;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  el.innerHTML = `
    <div class="view-header"><h1>Settings</h1></div>
    <div id="st-account">${account.panelHtml()}</div>

    <div class="card-panel">
      <h3>Your data</h3>
      <p class="small muted">${collection.length} collection entries · ${decks.length} decks · ${Object.keys(cards).length} cached cards<br>
      Collection value ${money(store.collectionValue().total)} · prices updated ${timeAgo(meta.lastRefresh)}</p>
      <p class="small muted">${sync.getUser() ? 'Stored on this device (IndexedDB) and synced to your account.' : 'Everything is stored on this device only (IndexedDB). Export a backup regularly, or sign in to sync.'}</p>
      <div class="actions">
        <button class="btn primary" id="st-export">Export backup</button>
        <label class="btn">Import backup<input type="file" id="st-import" accept="application/json,.json" hidden></label>
      </div>
      <button class="btn block" id="st-refresh" style="margin-top:8px">↻ Refresh all prices</button>
    </div>

    <div class="card-panel">
      <h3>Install on your phone</h3>
      ${standalone ? '<p class="small">✓ Running as an installed app.</p>' : `
      <p class="small muted"><b>iPhone (Safari):</b> tap Share → <i>Add to Home Screen</i>.<br>
      <b>Android (Chrome):</b> tap ⋮ → <i>Install app</i> / <i>Add to Home screen</i>.</p>
      <button class="btn block" id="st-install" hidden>Install app</button>`}
      <p class="small muted">Works offline for browsing your collection and decks; search, scanning lookups and price refresh need a connection.</p>
    </div>

    <div class="card-panel">
      <h3>About</h3>
      <p class="small muted">Card data, images and prices from <a href="https://scryfall.com" target="_blank" rel="noopener">Scryfall</a>.
      Prices are TCGplayer market prices (USD), refreshed by Scryfall about once a day. OCR by Tesseract.js.
      Not affiliated with Wizards of the Coast, Scryfall or TCGplayer. Magic: The Gathering is © Wizards of the Coast.</p>
    </div>

    <div class="card-panel">
      <h3>Danger zone</h3>
      <button class="btn block danger" id="st-wipe">Delete all data</button>
    </div>`;

  account.wirePanel($('#st-account', el), render);
  $('#st-export', el).onclick = exportBackup;
  $('#st-import', el).onchange = importBackup;
  $('#st-refresh', el).onclick = refreshPrices;
  $('#st-wipe', el).onclick = () => {
    if (!confirm('Delete your entire collection and all decks? This cannot be undone.')) return;
    store.replaceState({}); toast('All data deleted'); // tombstones propagate the deletion to the cloud if signed in
  };
  const inst = $('#st-install', el);
  if (inst && window.__installPrompt) {
    inst.hidden = false;
    inst.onclick = async () => { window.__installPrompt.prompt(); await window.__installPrompt.userChoice; window.__installPrompt = null; render(); };
  }
}

function exportBackup() {
  store.pruneCards();
  const { sync, tombstones, ...rest } = JSON.parse(JSON.stringify(store.state)); // device-only bookkeeping stays out of backups
  const data = { app: 'spellbook', exported: new Date().toISOString(), ...rest };
  download(`spellbook-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1));
  toast('Backup downloaded');
}

async function importBackup(e) {
  const file = e.target.files?.[0]; e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || !('collection' in data) || !('cards' in data)) throw new Error('Not a Spellbook backup');
    const merge = confirm('OK = merge with current data\nCancel = replace current data');
    if (merge) {
      const s = store.state;
      Object.assign(s.cards, data.cards);
      const have = new Set(s.collection.map((x) => x.uid));
      const newE = data.collection.filter((x) => !have.has(x.uid));
      s.collection.push(...newE); newE.forEach(store.touchEntry);
      const haveD = new Set(s.decks.map((x) => x.id));
      const newD = (data.decks || []).filter((x) => !haveD.has(x.id));
      s.decks.push(...newD); newD.forEach(store.touchDeck);
      store.save();
    } else store.replaceState(data);
    toast(`Imported ${data.collection.length} entries, ${(data.decks || []).length} decks`);
  } catch (err) {
    toast('Import failed: ' + err.message, 4000);
  }
}
