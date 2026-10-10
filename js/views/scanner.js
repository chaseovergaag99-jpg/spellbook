/**
 * views/scanner.js — Scan tab: identify cards with the camera.
 *
 * Flow: rear camera (getUserMedia, facingMode "environment") → user lines the
 * card's title bar up with the yellow guide → we crop that region from the
 * video frame → Tesseract.js OCR (ocr.js) → Scryfall /cards/named?fuzzy= with
 * /cards/autocomplete for alternates → result panel (pick printing/foil/qty,
 * add to collection or a deck in one tap) + a running "scanned" list.
 *
 * "Auto" mode scans continuously (~1 frame/sec) and, with "Auto-add" on,
 * adds each new card to the chosen target immediately.
 * Fallback: photo upload (<input type=file capture=environment>).
 * NOTE: browsers only allow camera access on HTTPS (or localhost).
 */
import * as store from '../store.js';
import * as sf from '../scryfall.js';
import * as ocr from '../ocr.js';
import * as names from '../names.js';
import { $, esc, priceStr, toast, stepperHtml, wireSteppers } from '../ui.js';
import { openCardSheet, deckPickerHtml, resolveDeckPick } from '../cardsheet.js';

let el, stream = null, auto = false, busy = false, loopTimer = null;
let scanned = [];          // running list: { key, card, qty, foil, added: null|'Collection'|deckName }
let current = null;        // { card, alts: [names], text, prints }
let lastName = '', lastTime = 0;
const opts = { autoAdd: false, foil: false, target: 'collection' };

export function mount(root) {
  el = root;
  const secure = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  el.innerHTML = `
    <div class="view-header"><h1>Scan</h1><span class="small muted" id="sc-count"></span></div>
    <div class="scanner-stage" id="sc-stage">
      <video id="sc-video" playsinline muted autoplay></video>
      <div class="scan-guide"><div class="card-frame"><div class="title-box" id="sc-title"></div></div>
        <div class="hint">Fill the frame with the card · title in the yellow box</div></div>
      <div class="scan-status"><span id="sc-status">${secure ? 'Tap “Start camera”' : 'Camera needs HTTPS — use “Photo” below'}</span></div>
      <div id="sc-off" class="empty" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px">
        ${secure ? '<button class="btn primary" id="sc-start">📷 Start camera</button>' : ''}
        <p class="small" style="max-width:260px">${secure ? 'Uses your rear camera. Nothing leaves your phone except the card name lookup.' : 'Live camera only works when the app is served over HTTPS (or localhost). You can still take/upload a photo.'}</p>
      </div>
    </div>
    <div class="scan-controls">
      <label class="btn" style="justify-self:start">🖼 Photo<input type="file" accept="image/*" capture="environment" id="sc-file" hidden></label>
      <button class="shutter" id="sc-shoot" aria-label="Scan now"></button>
      <button class="btn" id="sc-auto" style="justify-self:end">Auto: off</button>
    </div>
    <div class="row wrap small" style="gap:4px 14px;margin-bottom:8px">
      <label class="switch"><input type="checkbox" id="sc-autoadd"> Auto-add</label>
      <label class="switch"><input type="checkbox" id="sc-foil"> Foil</label>
      <select id="sc-target" style="width:auto;flex:1;min-width:150px" aria-label="Add scanned cards to"></select>
    </div>
    <div id="sc-result"></div>
    <div class="section-title"><span>Scanned this session</span><span><button class="btn small ghost" id="sc-addall">Add all</button><button class="btn small ghost" id="sc-clear">Clear</button></span></div>
    <div class="list" id="sc-list"></div>`;

  $('#sc-start', el)?.addEventListener('click', startCamera);
  $('#sc-shoot', el).addEventListener('click', () => (stream ? scanFrame(true) : secure ? startCamera() : $('#sc-file', el).click()));
  $('#sc-auto', el).addEventListener('click', toggleAuto);
  $('#sc-file', el).addEventListener('change', onFile);
  $('#sc-autoadd', el).addEventListener('change', (e) => (opts.autoAdd = e.target.checked));
  $('#sc-foil', el).addEventListener('change', (e) => (opts.foil = e.target.checked));
  $('#sc-target', el).addEventListener('change', (e) => {
    if (e.target.value === '__new') {
      const n = prompt('New deck name', 'New Deck');
      opts.target = n ? store.createDeck(n, 'Commander').id : 'collection';
    } else opts.target = e.target.value;
    renderTargets();
  });
  $('#sc-addall', el).addEventListener('click', () => { scanned.filter((s) => !s.added).forEach(addItem); renderList(); });
  $('#sc-clear', el).addEventListener('click', () => { scanned = []; renderList(); });
  $('#sc-list', el).addEventListener('click', onListClick);
  renderTargets(); renderList();
}

/* ---------- lifecycle (called by app.js when the tab is shown/hidden) ---------- */
export function show() { renderTargets(); }
export function hide() { stopCamera(); }

async function startCamera() {
  try {
    status('Starting camera…');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    const v = $('#sc-video', el);
    v.srcObject = stream; await v.play().catch(() => {});
    // Try continuous autofocus where supported (Chrome Android).
    const track = stream.getVideoTracks()[0];
    track.applyConstraints?.({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    $('#sc-off', el).hidden = true;
    status('Line up the card name, then tap the button');
    names.loadCatalog();
    ocr.getWorker(status).then(() => status(auto ? 'Auto scanning…' : 'Ready — tap to scan')).catch((e) => status('OCR failed to load: ' + (e?.message || e)));
  } catch (e) {
    status(e.name === 'NotAllowedError' ? 'Camera permission denied — use Photo' : 'Camera unavailable — use Photo');
    stream = null;
  }
}
function stopCamera() {
  auto = false; clearTimeout(loopTimer);
  stream?.getTracks().forEach((t) => t.stop()); stream = null;
  if (el) { $('#sc-off', el).hidden = false; $('#sc-auto', el).textContent = 'Auto: off'; }
}
function toggleAuto() {
  auto = !auto;
  $('#sc-auto', el).textContent = `Auto: ${auto ? 'on' : 'off'}`;
  $('#sc-auto', el).classList.toggle('primary', auto);
  if (auto) { if (!stream) startCamera().then(loop); else loop(); } else clearTimeout(loopTimer);
}
async function loop() {
  if (!auto || !stream) return;
  await scanFrame(false);
  loopTimer = setTimeout(loop, 700);
}
const status = (t) => { const s = el && $('#sc-status', el); if (s) { s.textContent = t; s.parentElement.hidden = !t; } };

/* ---------- capture ---------- */
/**
 * Map the on-screen yellow title box to video pixel coordinates and crop.
 * `inset` trims a fraction off the top/bottom (removes frame borders, which
 * helps OCR a lot) and a little off the sides.
 */
function cropTitleFromVideo(inset = 0) {
  const v = $('#sc-video', el), stage = $('#sc-stage', el).getBoundingClientRect(), box = $('#sc-title', el).getBoundingClientRect();
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw) return null;
  const s = Math.max(stage.width / vw, stage.height / vh);          // object-fit: cover scale
  const ox = (stage.width - vw * s) / 2, oy = (stage.height - vh * s) / 2;
  const iy = box.height * inset, ix = box.width * 0.01;
  const x = (box.left - stage.left - ox + ix) / s, y = (box.top - stage.top - oy + iy) / s;
  const w = (box.width - ix * 2) / s, h = (box.height - iy * 2) / s;
  const cx = Math.max(0, x), cy = Math.max(0, y);
  return ocr.preprocess(v, cx, cy, Math.min(vw - cx, w), Math.min(vh - cy, h));
}

async function scanFrame(manual) {
  if (busy) return;
  busy = true; $('#sc-shoot', el).classList.add('busy');
  try {
    // Try a tight crop first, then (manual taps only) a looser one.
    let canvas, text = '', confidence = 0, m = null;
    for (const inset of manual ? [0.18, 0, 0.3] : [0.18]) {
      canvas = cropTitleFromVideo(inset);
      if (!canvas) return;
      if (manual) status('Reading…');
      ({ text, confidence } = await ocr.recognize(canvas, status));
      if (!manual && confidence < 45) { status('Auto scanning… (hold steady)'); return; }
      if ((m = await matchText(text, { manual }))) break;
    }
    if (!m) { status(manual ? `Couldn't read “${ocr.cleanTitle(text) || '…'}” — try again` : 'Auto scanning…'); if (manual) showPreview(canvas, text); return; }
    // Debounce repeated reads of the same card in auto mode.
    if (!manual && m.card.name === lastName && Date.now() - lastTime < 6000) { lastTime = Date.now(); return; }
    lastName = m.card.name; lastTime = Date.now();
    onMatch(m, canvas, text);
  } catch (e) {
    status('Scan error: ' + (e?.message || e));
  } finally {
    busy = false; $('#sc-shoot', el)?.classList.remove('busy');
  }
}

/** Photo fallback: assume the card roughly fills the photo. */
async function onFile(e) {
  const file = e.target.files?.[0]; e.target.value = '';
  if (!file) return;
  busy = true; $('#sc-shoot', el).classList.add('busy');
  status('Reading photo…');
  names.loadCatalog();
  try {
    const bmp = await createImageBitmap(file);
    const W = bmp.width, H = bmp.height;
    // 1) Try the title-bar band of a card that fills the frame.
    let canvas = ocr.preprocess(bmp, W * 0.04, H * 0.025, W * 0.92, H * 0.09);
    let { text } = await ocr.recognize(canvas, status);
    let m = await matchText(text, { manual: true });
    // 2) Fallback: sparse OCR over the top third, try each line.
    if (!m) {
      const top = ocr.preprocess(bmp, 0, 0, W, H * 0.35);
      const lines = await ocr.recognizeLines(top, status);
      for (const line of lines.slice(0, 6)) { if ((m = await matchText(line, { manual: true }))) { text = line; canvas = top; break; } }
    }
    if (m) onMatch(m, canvas, text);
    else { status('No card name found — try a closer, straight-on photo'); showPreview(canvas, text); }
  } catch (err) {
    status('Could not read photo: ' + (err?.message || err));
  } finally {
    busy = false; $('#sc-shoot', el).classList.remove('busy');
  }
}

/* ---------- matching ---------- */
/**
 * OCR text → { card, alts }.
 *  1. Local catalog fuzzy match (no network) — confident hits go straight to
 *     /cards/named?exact=.
 *  2. Otherwise (manual scans, or catalog unavailable) ask Scryfall:
 *     /cards/named?fuzzy= and /cards/autocomplete.
 * Auto mode skips step 2 when the catalog is loaded, to stay well under
 * Scryfall's rate limit while scanning continuously.
 */
async function matchText(raw, { manual = false } = {}) {
  const cands = ocr.titleCandidates(raw);
  if (!cands.length) return null;
  if (names.catalogReady()) {
    let best = [];
    for (const c of cands) { const r = names.bestMatches(c); if (r[0] && (!best[0] || r[0].score > best[0].score)) best = r; }
    if (best[0]?.score >= 0.62) {
      const card = await sf.named(best[0].name).catch(() => null);
      if (card) return { card, alts: best.slice(1).filter((b) => b.score > 0.35).map((b) => b.name), text: cands[0] };
    }
    if (!manual) return null;
  }
  for (const cand of cands.slice(0, 3)) {
    let card = await sf.named(cand, { fuzzy: true }).catch(() => null);
    const alts = await sf.autocomplete(cand).catch(() => []);
    if (!card && alts.length) card = await sf.named(alts[0]).catch(() => null);
    if (card) return { card, alts: alts.filter((n) => n !== card.name).slice(0, 6), text: cand };
  }
  return null;
}

function onMatch(m, canvas, rawText) {
  navigator.vibrate?.(40);
  current = { ...m, prints: null };
  const item = { key: Date.now() + Math.random(), card: m.card, qty: 1, foil: opts.foil, added: null };
  scanned.unshift(item);
  if (opts.autoAdd) addItem(item);
  current.item = item;
  status(auto ? `✓ ${m.card.name} — next card` : `✓ ${m.card.name}`);
  renderResult(canvas, rawText);
  renderList();
}

/* ---------- adding ---------- */
function targetName(t) { return t === 'collection' ? 'Collection' : store.getDeck(t)?.name || 'Deck'; }
function addItem(item, target = opts.target) {
  if (target === 'collection') store.addToCollection(item.card, { qty: item.qty, foil: item.foil });
  else store.addToDeck(target, item.card, { qty: item.qty });
  item.added = targetName(target);
  toast(`Added ${item.qty}× ${item.card.name} → ${item.added}`);
}

/* ---------- rendering ---------- */
function renderTargets() {
  if (!el) return;
  if (opts.target !== 'collection' && !store.getDeck(opts.target)) opts.target = 'collection';
  $('#sc-target', el).innerHTML = `<option value="collection">→ Collection</option>` +
    store.state.decks.map((d) => `<option value="${esc(d.id)}">→ Deck: ${esc(d.name)}</option>`).join('') + `<option value="__new">→ New deck…</option>`;
  $('#sc-target', el).value = opts.target;
}

function showPreview(canvas, text) {
  $('#sc-result', el).innerHTML = `<div class="card-panel small muted">OCR read: “${esc(text.trim() || '(nothing)')}”
    <img class="ocr-preview" src="${canvas.toDataURL()}" alt="Cropped title"><br>Tip: fill the frame, avoid glare, hold steady.</div>`;
}

function renderResult(canvas, rawText) {
  const { card, alts, item } = current;
  const box = $('#sc-result', el);
  box.innerHTML = `<div class="card-panel">
    <div class="match-card">
      <button class="grid-card" id="sr-open"><div class="img">${card.image ? `<img src="${esc(card.image)}" alt="${esc(card.name)}">` : ''}</div></button>
      <div style="min-width:0">
        <h2>${esc(card.name)}</h2>
        <div class="small muted" id="sr-set">${esc(card.set_name)} · #${esc(card.collector_number)}</div>
        <div class="price-row"><div>Normal<b id="sr-usd">${priceStr(card.prices.usd)}</b></div><div>Foil<b id="sr-foilp">${priceStr(card.prices.usd_foil)}</b></div></div>
        <div class="small muted">Owned: ${store.ownedCountByName(card.name)}</div>
        <div class="small muted" style="margin-top:4px">Read: “${esc(ocr.cleanTitle(rawText))}”</div>
      </div>
    </div>
    ${alts.length ? `<div class="small muted" style="margin-top:10px">Not it? Try:</div><div class="suggest">${alts.map((n) => `<button class="chip" data-alt="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
    <label class="field"><span>Printing / set</span><select id="sr-print"><option>${esc(card.set_name)} (${esc(card.set.toUpperCase())} #${esc(card.collector_number)})</option></select></label>
    <div class="row wrap" style="justify-content:space-between">${stepperHtml('qty', item.qty)}
      <label class="switch"><input type="checkbox" id="sr-foil" ${item.foil ? 'checked' : ''}> Foil</label></div>
    <div class="actions">
      <button class="btn primary" id="sr-col">${item.added === 'Collection' ? '✓ In collection' : '＋ Collection'}</button>
      <button class="btn" id="sr-deck">＋ Deck</button>
    </div>
    <div style="margin-top:8px">${deckPickerHtml(opts.target !== 'collection' ? opts.target : null)}</div>
  </div>`;
  const qty = wireSteppers(box, (_, v) => (item.qty = v));
  $('#sr-foil', box).onchange = (e) => (item.foil = e.target.checked);
  $('#sr-open', box).onclick = () => openCardSheet(item.card);
  $('#sr-col', box).onclick = () => { item.qty = qty('qty'); addItem(item, 'collection'); renderList(); $('#sr-col', box).textContent = '✓ Added'; };
  $('#sr-deck', box).onclick = () => {
    const pick = resolveDeckPick(box); if (!pick) return;
    item.qty = qty('qty');
    store.addToDeck(pick.deckId, item.card, { qty: item.qty, section: pick.section });
    item.added = store.getDeck(pick.deckId).name; toast(`Added → ${item.added}`); renderList();
  };
  box.querySelectorAll('[data-alt]').forEach((b) => (b.onclick = async () => {
    const c = await sf.named(b.dataset.alt); if (!c) return;
    item.card = c; current.card = c; current.alts = alts.filter((n) => n !== c.name).concat(card.name);
    renderResult(canvas, rawText); renderList();
  }));
  // Load printings lazily
  const sel = $('#sr-print', box);
  sf.printings(card.name).then((prints) => {
    if (!sel.isConnected || current.card !== card) return;
    sel.innerHTML = prints.map((p) => `<option value="${esc(p.id)}" ${p.id === card.id ? 'selected' : ''}>${esc(p.set_name)} (${esc(p.set.toUpperCase())} #${esc(p.collector_number)})${p.prices.usd ? ' · $' + p.prices.usd : ''}</option>`).join('');
    sel.onchange = () => {
      const p = prints.find((x) => x.id === sel.value); if (!p) return;
      item.card = p; current.card = p;
      $('#sr-set', box).textContent = `${p.set_name} · #${p.collector_number}`;
      $('#sr-usd', box).textContent = priceStr(p.prices.usd); $('#sr-foilp', box).textContent = priceStr(p.prices.usd_foil);
      $('#sr-open', box).querySelector('.img').innerHTML = p.image ? `<img src="${esc(p.image)}" alt="">` : '';
      renderList();
    };
  }).catch(() => {});
}

function renderList() {
  if (!el) return;
  $('#sc-count', el).textContent = scanned.length ? `${scanned.length} scanned` : '';
  $('#sc-list', el).innerHTML = scanned.length ? scanned.map((s) => `
    <div class="item" data-key="${s.key}">
      <div class="thumb">${s.card.image_small ? `<img src="${esc(s.card.image_small)}" alt="">` : ''}</div>
      <div class="body"><div class="name">${esc(s.card.name)} ${s.foil ? '<span class="badge foil">FOIL</span>' : ''}</div>
        <div class="sub">${esc(s.card.set.toUpperCase())} · ×${s.qty} · ${priceStr(s.foil ? s.card.prices.usd_foil : s.card.prices.usd)}</div>
        <div class="sub">${s.added ? `<span class="badge owned">✓ ${esc(s.added)}</span>` : '<span class="badge">not added</span>'}</div></div>
      <div class="row">${s.added ? '' : `<button class="btn small primary" data-add="${s.key}" aria-label="Add">＋</button>`}
        <button class="btn small ghost" data-del="${s.key}" aria-label="Remove from list">✕</button></div>
    </div>`).join('') : `<div class="empty small">Scanned cards show up here. Turn on <b>Auto</b> to scan card after card.</div>`;
}

function onListClick(e) {
  const add = e.target.closest('[data-add]'), del = e.target.closest('[data-del]'), row = e.target.closest('[data-key]');
  if (add) { const s = scanned.find((x) => String(x.key) === add.dataset.add); if (s) { addItem(s); renderList(); } return; }
  if (del) { scanned = scanned.filter((x) => String(x.key) !== del.dataset.del); renderList(); return; }
  if (row) { const s = scanned.find((x) => String(x.key) === row.dataset.key); if (s) openCardSheet(s.card); }
}
