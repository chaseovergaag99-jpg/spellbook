/**
 * End-to-end cloud-sync test: two "devices" (browser contexts) + one user,
 * against the local Supabase mock (dev/supabase-mock/server.mjs).
 *
 * Prereqs: app served on :8080, mock running on :54321 (see README "Testing").
 * js/config.js is swapped at request time for one pointing at the mock.
 */
import { chromium, devices } from 'playwright';
const BASE = 'http://localhost:8080/';
const MOCK = 'http://localhost:54321';
const ANON = await (async () => { const fs = await import('node:fs'); return fs.readFileSync('/tmp/mock.log', 'utf8').match(/anon key: (\S+)/)[1]; })();
const CONFIG = `export const SUPABASE_URL='${MOCK}'; export const SUPABASE_ANON_KEY='${ANON}';
export const ENABLE_GOOGLE_AUTH=true; export const ENABLE_MAGIC_LINK=true; export const SYNC_ENABLED=true;`;
const EMAIL = `user${Date.now()}@test.dev`, PASS = 'hunter22';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };
const b = await chromium.launch();

async function device(name) {
  const ctx = await b.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  await ctx.route('**/js/config.js', (r) => r.fulfill({ contentType: 'application/javascript', body: CONFIG }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`[${name}] pageerror`, e.message); fails++; });
  await page.goto(BASE + '#collection');
  await page.waitForFunction(() => document.querySelector('#c-summary'));
  return { ctx, page, name };
}
const S = (page) => page.evaluate(async () => { const s = await import('./js/store.js'); return JSON.parse(JSON.stringify(s.state)); });
const sync = (page) => page.evaluate(async () => { const m = await import('./js/sync.js'); await m.syncNow(); return m.getStatus(); });
const fakeCard = (id, name, usd) => ({ id, name, set: 'tst', set_name: 'Test Set', collector_number: '1', rarity: 'rare', type_line: 'Instant', mana_cost: '{R}', cmc: 1, colors: ['R'], color_identity: ['R'], oracle_text: '', image: '', image_small: '', prices: { usd, usd_foil: null }, finishes: ['nonfoil'], fetched: new Date().toISOString() });
const addCard = (page, card, qty) => page.evaluate(async ([c, q]) => { const s = await import('./js/store.js'); s.addToCollection(c, { qty: q }); }, [card, qty]);
async function signIn(page, signup) {
  await page.click('.tab[data-tab=settings]');
  if (signup) await page.click('#acct-mode');
  await page.fill('#acct-email', EMAIL); await page.fill('#acct-pass', PASS);
  await page.click('#acct-submit');
  await page.waitForFunction(() => /Synced/.test(document.querySelector('#acct-status')?.textContent || ''), null, { timeout: 15000 });
}

// ---------- Device A: local-only data, then create account ----------
const A = await device('A');
ok(await A.page.locator('#sync-banner').isVisible(), 'A: sign-in banner visible in Collection when signed out');
await addCard(A.page, fakeCard('card-bolt', 'Lightning Bolt', '1.00'), 4);
await A.page.evaluate(async () => { const s = await import('./js/store.js'); const d = s.createDeck('Burn', 'Modern'); s.addToDeck(d.id, s.state.cards['card-bolt'], { qty: 4 }); });
await A.page.click('.tab[data-tab=settings]');
ok(await A.page.locator('#acct-google').isVisible(), 'A: Google button shown when ENABLE_GOOGLE_AUTH');
ok(await A.page.locator('#acct-magic').isVisible(), 'A: magic-link button shown');
await signIn(A.page, true);
let sa = await S(A.page);
ok(Object.keys(sa.sync.dirty.collection).length === 0 && Object.keys(sa.sync.dirty.decks).length === 0, 'A: everything pushed after sign-up (dirty queue empty)');
await A.page.click('.tab[data-tab=collection]');
ok(/Synced/.test(await A.page.textContent('#c-sync')), 'A: Collection shows sync chip');

// ---------- Device B: its own local data, sign in → merge ----------
const B = await device('B');
await addCard(B.page, fakeCard('card-ring', 'Sol Ring', '2.00'), 1);
await signIn(B.page, false);
let sb = await S(B.page);
ok(sb.collection.length === 2 && sb.collection.some((e) => e.cardId === 'card-bolt') && sb.collection.some((e) => e.cardId === 'card-ring'), 'B: first sign-in merged cloud + local collection (2 entries)');
ok(sb.decks.length === 1 && sb.decks[0].name === 'Burn' && sb.decks[0].cards[0].qty === 4, 'B: received deck from A with cards');
ok(sb.cards['card-bolt']?.name === 'Lightning Bolt', 'B: card snapshot came with the row (renders offline)');
await sync(A.page); sa = await S(A.page);
ok(sa.collection.length === 2 && sa.collection.some((e) => e.cardId === 'card-ring'), 'A: got B\'s local card on next sync (nothing lost)');

// ---------- edits + deletes propagate ----------
await B.page.evaluate(async () => { const s = await import('./js/store.js'); const e = s.state.collection.find((x) => x.cardId === 'card-bolt'); s.updateEntry(e.uid, { qty: 7 }); s.deleteDeck(s.state.decks[0].id); });
// (waitForFunction can't await async predicates, so poll manually)
const until = async (page, fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await page.evaluate(fn)) return true; await page.waitForTimeout(250); } return false; };
const pushedFast = await until(B.page, async () => { const s = await import('./js/store.js'); return !Object.keys(s.state.sync.dirty.collection).length && !Object.keys(s.state.sync.dirty.decks).length; }, 1000);
ok(!pushedFast, 'B: edits are queued (not pushed instantly)');
ok(await until(B.page, async () => { const m = await import('./js/sync.js'); const s = await import('./js/store.js'); return m.getStatus().state === 'synced' && !Object.keys(s.state.sync.dirty.collection).length && !Object.keys(s.state.sync.dirty.decks).length; }), 'B: debounced auto-sync pushed edits within a few seconds');
await sync(A.page); sa = await S(A.page);
ok(sa.collection.find((e) => e.cardId === 'card-bolt')?.qty === 7, 'A: qty edit from B applied');
ok(sa.decks.length === 0 && Object.keys(sa.tombstones.decks).length === 1, 'A: deck deletion from B applied (soft delete)');
await B.page.evaluate(async () => { const s = await import('./js/store.js'); const e = s.state.collection.find((x) => x.cardId === 'card-ring'); s.removeEntry(e.uid); });
await sync(B.page); await sync(A.page); sa = await S(A.page);
ok(!sa.collection.some((e) => e.cardId === 'card-ring'), 'A: collection removal from B applied');

// ---------- last-write-wins on a conflicting edit ----------
await A.ctx.setOffline(true);
await A.page.evaluate(async () => { const s = await import('./js/store.js'); const e = s.state.collection[0]; s.updateEntry(e.uid, { qty: 10 }); });
await A.page.waitForTimeout(50);
await B.page.evaluate(async () => { const s = await import('./js/store.js'); const e = s.state.collection[0]; s.updateEntry(e.uid, { qty: 20 }); });
await sync(B.page);
const offlineStatus = await sync(A.page);
ok(['offline', 'error'].includes(offlineStatus.state), `A: offline sync reports "${offlineStatus.state}" and keeps changes queued`);
await A.ctx.setOffline(false);
await sync(A.page); await sync(B.page);
sa = await S(A.page); sb = await S(B.page);
ok(sa.collection[0].qty === 20 && sb.collection[0].qty === 20, 'Conflict: newer edit (B, qty 20) wins on both devices');

// ---------- reload: session persists, sync on open ----------
await B.page.evaluate(async () => { const s = await import('./js/store.js'); s.addToCollection({ ...s.state.cards['card-bolt'], id: 'card-new', name: 'Shock' }, { qty: 2 }); });
await sync(B.page);
await A.page.reload();
ok(await until(A.page, async () => { const s = await import('./js/store.js'); return s.state.collection.some((e) => e.cardId === 'card-new'); }), 'A: after reload, still signed in and synced on app open');

// ---------- sign out keeps local data ----------
await A.page.click('.tab[data-tab=settings]');
await A.page.click('#acct-out'); await A.page.click('#so-keep');
await A.page.waitForSelector('#acct-form');
sa = await S(A.page);
ok(sa.collection.length === 2 && sa.sync.userId === null, 'A: signed out, local data kept, sync state reset');
await A.page.click('#acct-mode'); await A.page.fill('#acct-email', EMAIL); await A.page.fill('#acct-pass', PASS); await A.page.click('#acct-submit');
await A.page.waitForSelector('.small[style*="bad"], #acct-msg:not(:empty)', { timeout: 10000 });
ok(/already/i.test(await A.page.textContent('#acct-msg')), 'A: duplicate sign-up shows error message');

// ---------- a different user sees nothing of the first user's ----------
const C = await device('C');
await C.page.click('.tab[data-tab=settings]'); await C.page.click('#acct-mode');
await C.page.fill('#acct-email', 'other' + EMAIL); await C.page.fill('#acct-pass', PASS); await C.page.click('#acct-submit');
await C.page.waitForFunction(() => /Synced/.test(document.querySelector('#acct-status')?.textContent || ''), null, { timeout: 15000 });
ok((await S(C.page)).collection.length === 0, 'C (other user): sees none of the first user\'s data (RLS)');
await C.page.fill('#acct-email', 'x').catch(() => {});

// ---------- "Confirm email" ON: graceful sign-up flow ----------
const D = await device('D');
const CEMAIL = `new+confirm${Date.now()}@test.dev`;
const reqs = []; D.page.on('request', (r) => r.url().includes('/auth/v1/') && reqs.push(r.url()));
await D.page.click('.tab[data-tab=settings]'); await D.page.click('#acct-mode');
await D.page.fill('#acct-email', CEMAIL); await D.page.fill('#acct-pass', PASS); await D.page.click('#acct-submit');
await D.page.waitForSelector('#acct-confirm', { timeout: 10000 });
ok(/confirmation link/.test(await D.page.textContent('#acct-confirm')) && await D.page.locator('#acct-resend').isVisible(), 'D: sign-up with confirmation → "check your inbox" screen + resend button');
const signupUrl = reqs.find((u) => u.includes('/signup'));
ok(signupUrl && decodeURIComponent(signupUrl).includes('redirect_to=http://localhost:8080/'), 'D: emailRedirectTo is the current page URL');
await D.page.evaluate(async () => { const s = await import('./js/store.js'); s.save(); }); await D.page.waitForTimeout(300);
ok(await D.page.locator('#acct-confirm').isVisible(), 'D: confirm screen survives unrelated re-renders');
await D.page.click('#acct-resend'); await D.page.waitForFunction(() => /sent again/.test(document.querySelector('#acct-msg').textContent));
ok(true, 'D: resend confirmation works');
await D.page.click('#acct-mode');
await D.page.fill('#acct-email', CEMAIL); await D.page.fill('#acct-pass', PASS); await D.page.click('#acct-submit');
await D.page.waitForFunction(() => /confirm your email/i.test(document.querySelector('#acct-msg').textContent));
ok(true, 'D: signing in before confirming shows a friendly "confirm your email" message');
await D.page.goto(BASE + '?code=stale-or-other-browser');
await D.page.waitForFunction(() => /Email confirmed/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
ok(await D.page.evaluate(() => !location.search), 'D: landing from a confirm link in another browser → "please sign in" notice, URL cleaned');
await D.page.goto(BASE + '?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
await D.page.waitForFunction(() => /expired/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
ok(await D.page.evaluate(() => !location.search), 'D: expired-link error shown as a toast, URL cleaned');

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL SYNC TESTS PASSED');
await b.close();
process.exit(fails ? 1 : 0);
