import { chromium, devices } from 'playwright';
import fs from 'fs';
const BASE = 'http://localhost:8080/';
const SHOTS = new URL('../screenshots/', import.meta.url).pathname;
const errors = [];
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices['iPhone 13'], permissions: ['camera', 'clipboard-read', 'clipboard-write'] });
// Fake camera: a canvas stream showing a card, sized to fill the guide frame.
const elvesB64 = fs.readFileSync(new URL('./elves.jpg', import.meta.url)).toString('base64');
await ctx.addInitScript((b64) => {
  navigator.mediaDevices.getUserMedia = async () => {
    const r = document.querySelector('#sc-stage').getBoundingClientRect(); const c = document.createElement('canvas'); c.width = Math.round(r.width*2); c.height = Math.round(r.height*2); const CW=c.width, CH=c.height;
    const g = c.getContext('2d'); const img = new Image(); window.__fakeImg = img; img.src = 'data:image/jpeg;base64,' + b64;
    await img.decode();
    const draw = () => { g.fillStyle = '#333'; g.fillRect(0, 0, CW, CH); const h = CH * 0.88, w = h * 63 / 88; g.drawImage(img, (CW - w) / 2, (CH - h) / 2, w, h); requestAnimationFrame(draw); };
    draw();
    return c.captureStream(15);
  };
}, elvesB64);
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const step = (s) => console.log('▶', s);
const toastText = async () => (await page.locator('#toast').textContent());

await page.goto(BASE);
await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true));
const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return r.active?.state; });
const manifest = await page.evaluate(async () => (await (await fetch(document.querySelector('link[rel=manifest]').href)).json()).icons.length);
step(`SW state=${sw}, manifest icons=${manifest}`);

// --- Search
step('search Lightning Bolt');
await page.fill('#s-q', 'Lightning Bolt');
await page.waitForSelector('.ac-list button', { timeout: 10000 });
console.log('  autocomplete:', await page.locator('.ac-list button').count());
await page.press('#s-q', 'Enter');
await page.waitForSelector('#s-results .grid-card', { timeout: 15000 });
console.log('  results:', await page.locator('#s-results .grid-card').count(), await page.textContent('#s-info'));
await page.locator('#s-results .grid-card').first().click();
await page.waitForSelector('#cs-add');
await page.waitForFunction(() => document.querySelectorAll('#cs-print option').length > 5, null, { timeout: 15000 });
console.log('  printings:', await page.locator('#cs-print option').count());
await page.click('[data-stepper="qty"] [data-step="1"]'); await page.click('[data-stepper="qty"] [data-step="1"]'); await page.click('[data-stepper="qty"] [data-step="1"]');
await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#sheet').scrollTop = 0; });
await page.screenshot({ path: SHOTS + '02-card-detail.png' });
await page.click('#cs-add');
console.log('  toast:', await toastText());

async function quickAdd(q, foil = false) {
  await page.fill('#s-q', q); await page.press('#s-q', 'Enter');
  await page.waitForSelector('#s-results .grid-card', { timeout: 15000 });
  await page.waitForTimeout(300);
  await page.locator('#s-results .grid-card').first().click();
  await page.waitForSelector('#cs-add');
  if (foil) await page.check('#cs-foil');
  await page.click('#cs-add');
  console.log('  ', await toastText());
}
step('add more cards');
await quickAdd('!"Sol Ring"');
await quickAdd('t:dragon c:r r:mythic');
await quickAdd('!"Counterspell"', true);
await quickAdd('!"Llanowar Elves"');
await page.fill('#s-q', 't:dragon c:r'); await page.press('#s-q', 'Enter');
await page.waitForSelector('#s-results .grid-card'); await page.waitForTimeout(1500);
await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#sheet').scrollTop = 0; });
await page.screenshot({ path: SHOTS + '01-search.png' });

// --- Collection
step('collection');
await page.click('.tab[data-tab=collection]');
console.log('  summary:', (await page.textContent('#c-summary')).replace(/\s+/g, ' '));
await page.selectOption('#c-sort', 'price');
const names = await page.locator('#c-list .name').allTextContents();
const prices = await page.locator('#c-list .right .price').allTextContents();
console.log('  by price desc:', names.map((n, i) => n.trim() + ' ' + prices[i]).join(' | '));
await page.selectOption('#c-sort', 'name');
console.log('  by name:', (await page.locator('#c-list .name').allTextContents()).map((s) => s.trim()).join(', '));
await page.selectOption('#c-sort', 'cmc'); console.log('  by cmc:', (await page.locator('#c-list .name').allTextContents()).map((s) => s.trim()).join(', '));
await page.selectOption('#c-sort', 'color'); console.log('  by color:', (await page.locator('#c-list .name').allTextContents()).map((s) => s.trim()).join(', '));
await page.fill('#c-text', 'bolt'); console.log('  filter bolt:', await page.locator('#c-list .item').count());
await page.fill('#c-text', '');
await page.click('[data-color="U"]'); console.log('  blue filter:', await page.locator('#c-list .item').count()); await page.click('[data-color="U"]');
// edit entry
await page.locator('#c-list .item').first().click(); await page.waitForSelector('#cs-save');
await page.click('[data-stepper="qty"] [data-step="1"]'); await page.click('#cs-save');
step('refresh prices');
// Simulate an old price to verify change tracking
await page.evaluate(async () => {
  const s = await import('/js/store.js'); const id = Object.keys(s.state.cards)[0];
  s.state.cards[id].prices.usd = '0.01'; s.save();
});
await page.click('#c-refresh');
await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Updated'), null, { timeout: 20000 });
console.log('  ', await toastText(), '|', await page.textContent('#c-updated'));
console.log('  deltas shown:', await page.locator('#c-list .delta-up, #c-list .delta-down').count());
await page.selectOption('#c-sort', 'value');
await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#sheet').scrollTop = 0; });
await page.screenshot({ path: SHOTS + '03-collection.png' });

// --- Decks
step('decks');
await page.click('.tab[data-tab=decks]');
await page.click('#d-new');
await page.fill('#nd-name', 'Izzet Test'); await page.selectOption('#nd-format', 'Modern'); await page.click('#nd-go');
await page.fill('#d-add', 'Counterspell'); await page.press('#d-add', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('#d-cards [data-row]').length >= 1, null, { timeout: 10000 });
await page.click('#d-menu'); await page.click('#dm-import');
await page.fill('#im-text', '4 Lightning Bolt\n4 Monastery Swiftspear (KTK) 118\n2 Snapcaster Mage\n4 Expressive Iteration\n10 Island\n10 Mountain\n1 Fire // Ice\n2 Notarealcardname\n\nSideboard\n2 Smash to Smithereens');
await page.click('#im-go');
await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('Imported'), null, { timeout: 20000 });
console.log('  ', await toastText());
console.log('  deck summary:', (await page.locator('#view-decks .summary').textContent()).replace(/\s+/g, ' '));
console.log('  curve:', (await page.locator('.curve').textContent()).replace(/\s+/g, ' '));
console.log('  colors:', (await page.locator('.legend').textContent()).replace(/\s+/g, ' '));
console.log('  missing badges:', await page.locator('.badge.missing').count(), 'owned badges:', await page.locator('#d-cards .badge.owned').count());
await page.locator('#d-cards [data-row] [data-dstep="1"]').first().click();
await page.click('#d-from-col'); await page.locator('#pc-list [data-pc]').first().click(); await page.click('#sheet-backdrop', { position: { x: 10, y: 10 } });
await page.click('#d-menu'); await page.click('#dm-export');
console.log('  export:\n' + (await page.inputValue('#ex-text')).split('\n').map((l) => '     ' + l).join('\n'));
await page.click('#sheet-backdrop', { position: { x: 10, y: 10 } });
await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#sheet').scrollTop = 0; });
await page.screenshot({ path: SHOTS + '04-deck.png', fullPage: false });
await page.evaluate(() => window.scrollTo(0, 400)); await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#sheet').scrollTop = 0; });
await page.screenshot({ path: SHOTS + '05-deck-list.png' });

// --- Scanner (fake camera stream with Llanowar Elves)
step('scanner live');
await page.click('.tab[data-tab=scan]');
await page.click('#sc-start');
await page.waitForFunction(() => /Ready|Line up/.test(document.querySelector('#sc-status').textContent), null, { timeout: 60000 });
await page.waitForFunction(() => /Ready/.test(document.querySelector('#sc-status').textContent), null, { timeout: 60000 });
await page.click('#sc-shoot');
await page.waitForFunction(() => /✓|Couldn|error/.test(document.querySelector('#sc-status').textContent), null, { timeout: 60000 });
console.log('  status:', await page.textContent('#sc-status'));
console.log('  result:', (await page.locator('#sc-result h2').textContent().catch(() => 'none')));
await page.waitForTimeout(1500);
await page.click('#sr-col').catch(() => {});
await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(400);
await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#sheet').scrollTop = 0; });
await page.screenshot({ path: SHOTS + '06-scanner.png' });
step('scanner photo upload (Lightning Bolt)');
await page.setInputFiles('#sc-file', new URL('./bolt.jpg', import.meta.url).pathname);
await page.waitForFunction(() => /✓|No card|Could not/.test(document.querySelector('#sc-status').textContent) && !/Reading/.test(document.querySelector('#sc-status').textContent), null, { timeout: 60000 });
console.log('  status:', await page.textContent('#sc-status'));
console.log('  scanned list:', (await page.locator('#sc-list .name').allTextContents()).map((s) => s.trim()).join(', '));
step('auto mode');
await page.click('#sc-autoadd');
await page.click('#sc-auto'); await page.waitForTimeout(2500);
const solB64 = fs.readFileSync(new URL('./solring.jpg', import.meta.url)).toString('base64');
await page.evaluate((b) => { window.__fakeImg.src = 'data:image/jpeg;base64,' + b; }, solB64);
await page.waitForFunction(() => /Sol Ring/.test(document.querySelector('#sc-list').textContent), null, { timeout: 30000 }).catch(() => console.log('  auto: Sol Ring not detected'));
await page.click('#sc-auto');
console.log('  auto list:', (await page.locator('#sc-list .item').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join(' || '));
const solOwned = await page.evaluate(async () => { const s = await import('/js/store.js'); return s.ownedCountByName('Sol Ring'); });
console.log('  Sol Ring owned after auto-add:', solOwned);
console.log('  scanned list after auto:', (await page.locator('#sc-list .name').allTextContents()).length);

// --- Settings / backup
console.log('  SW runtime cache (OCR files):', await page.evaluate(async () => (await (await caches.open('runtime-v1')).keys()).map((r) => r.url.split('/').pop()).join(', ')));
step('settings backup');
await page.click('.tab[data-tab=settings]');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#st-export')]);
const p = await dl.path(); const data = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('  backup: entries', data.collection.length, 'decks', data.decks.length, 'cards', Object.keys(data.cards).length);

// persistence across reload
await page.reload(); await page.click('.tab[data-tab=collection]');
console.log('  after reload items:', await page.locator('#c-list .item, #c-list .grid-card').count());
// horizontal overflow check on each tab
for (const t of ['search', 'scan', 'collection', 'decks', 'settings']) {
  await page.click(`.tab[data-tab=${t}]`);
  const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (o > 0) errors.push(`horizontal overflow on ${t}: ${o}px`);
}
// offline: reload with network offline
await ctx.setOffline(true); await page.reload(); await page.click('.tab[data-tab=decks]');
console.log('  offline decks shown:', await page.locator('[data-deck]').count());
await ctx.setOffline(false);

console.log('\nERRORS:', errors.length ? errors.join('\n') : 'none');
await b.close();
