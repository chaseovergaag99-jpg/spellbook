# Spellbook: MTG Collection, Scanner & Deck Builder (PWA)

A mobile-first Progressive Web App for Magic: The Gathering. It's a static site
(plain HTML/CSS/ES modules, **no build step**), so you can host it free on
GitHub Pages, Netlify, Cloudflare Pages, Vercel and similar.

- **Search**: Scryfall autocomplete + full Scryfall search syntax (`t:dragon c:r`, `set:mh3 r:mythic`…)
- **Scan**: rear camera + guide overlay → crop title bar → Tesseract.js OCR (on device) → card match.
  Pick printing / foil / qty, add to collection or a deck in one tap. Auto mode scans continuously,
  with an optional auto-add, and keeps a running list. A photo-upload fallback is included.
- **Collection**: printing/set, qty, foil, condition; per-card and total value; **Refresh prices**
  (batch `/cards/collection`, 75 ids per request) with last-updated time and change since the last refresh;
  sort by name / price / total value / color / type / rarity / set / mana value / date added; text, color and rarity filters; list or grid view.
- **Decks**: multiple decks with a format; Commander / Main / Sideboard; counts; mana curve; color breakdown;
  deck price; "need N" flags for cards you don't own, plus a shopping list; plain-text import/export (`4 Lightning Bolt`).
- **Backup**: export/import the full state as JSON (Settings).
- **Accounts & cloud sync (optional, Supabase)**: email/password sign-up and sign-in, magic link, optional Google,
  password reset, and sign-out. Data stays local-first and syncs automatically across devices. Turned off until `js/config.js` has keys.
- **Offline**: the service worker caches the app shell, card images and (after first use) the OCR engine.

Prices are Scryfall's `prices.usd` / `prices.usd_foil`, which are **TCGplayer market prices**,
updated by Scryfall about once a day. Every card links to its `purchase_uris.tcgplayer` page.

## Run locally

```bash
cd mtg-app
python3 -m http.server 8080      # or: npx serve .
# open http://localhost:8080
```

The camera only works on **HTTPS** or `http://localhost`. To test on your phone, deploy it (below), or use
an HTTPS tunnel. Over plain-HTTP LAN addresses the Scan tab falls back to photo upload.

## Deploy (any static host)

Upload the folder as-is. Every path is relative, so it also works from a sub-path like `user.github.io/mtg-app/`.

- **GitHub Pages**: push to a repo → Settings → Pages → deploy from branch (root). `.nojekyll` is included.
- **Netlify**: drag the folder onto https://app.netlify.com/drop, or `netlify deploy --dir . --prod`.
- **Cloudflare Pages**: `wrangler pages deploy .`
- **Vercel**: `vercel --prod` (static, no framework).

Then on the phone: **iPhone Safari** → Share → *Add to Home Screen*. **Android Chrome** → ⋮ → *Install app*.

## Cloud sync setup (Supabase)

This copy is configured for project `wjuqqxstoxfgnmpardyp` (publishable key in `js/config.js`).
If `SUPABASE_URL` / `SUPABASE_ANON_KEY` are emptied, the app is purely local and never loads supabase-js.
Setup steps for a project:

1. **Create a project** at https://supabase.com (the free tier is fine).
2. **Create the tables**: open SQL Editor → New query, paste [`supabase/schema.sql`](supabase/schema.sql) and run it. It's safe to re-run.
   This creates `collection_items` and `decks` with Row Level Security (each user can only select, insert, update or delete their own rows),
   a last-write-wins trigger, and soft-delete columns.
3. **Get your keys**: Project Settings → API Keys (or *Connect*). Copy the **Project URL** and the **publishable** key (`sb_publishable_…`, or the legacy `anon` JWT) into `js/config.js`.
   The anon key is meant to be public; never put the `service_role` / secret key in the app.
4. **Set the auth URLs**: Authentication → URL Configuration
   - **Site URL**: `https://chaseovergaag99-jpg.github.io/spellbook/`
   - **Redirect URLs**: add `https://chaseovergaag99-jpg.github.io/spellbook/` and `https://chaseovergaag99-jpg.github.io/spellbook/**`
     (and `http://localhost:8080/` if you test locally).
5. **Email sign-in**: Authentication → Sign In / Providers → Email is enabled by default.
   - *Confirm email* ON (the default) means new users must click the link in their email before signing in. The app handles this:
     - After sign-up it shows a "check your inbox" screen with a *Resend confirmation email* button.
     - Signing in before confirming shows a friendly message plus the resend option.
     - The link returns to the page the user signed up from (`emailRedirectTo` = current page URL) and signs them in.
     - If the link is opened in a different browser or app, the email still gets confirmed, and the app asks them to sign in.
     - Expired or invalid links show a toast.
   - Supabase's built-in email sender is heavily rate-limited (a few emails per hour). For real use, set up custom SMTP under Authentication → Emails → SMTP settings.
   - Magic links and password reset use the same email templates. You can hide the magic-link button with `ENABLE_MAGIC_LINK = false`.
6. **Google sign-in (optional)**:
   - In Google Cloud Console, create an OAuth client (Web application) and add Supabase's callback URL
     (`https://<project-ref>.supabase.co/auth/v1/callback`) as an authorized redirect URI.
   - In Supabase → Authentication → Providers → Google, paste the client ID and secret and enable it.
   - Set `ENABLE_GOOGLE_AUTH = true` in `js/config.js`.
7. **Deploy**: commit `js/config.js`, push, and hard-refresh the app once.

### How sync works

- IndexedDB on the device is always the source of truth. The app works fully offline and signed out.
- Every collection entry and deck has an `updated` timestamp. Deletions leave a tombstone that syncs as `deleted = true`.
- A sync is **pull → merge → push**:
  - It pulls rows changed since the last sync (by the server-set `synced_at`).
  - It merges them with **last-write-wins per record** (`updated_at`).
  - It upserts every locally changed record. A database trigger also refuses stale writes, so an older edit can never overwrite a newer one.
- **First sign-in on a device** queues every local record, so local and cloud data are merged and nothing is lost.
  Two separately added copies of the same card stay as two rows.
- **When it syncs**: on app open and sign-in, about 2 s after any edit, when the app comes back online or to the foreground, and every 5 minutes.
  The status shows in Settings → Account and as a chip at the top of Collection (a sign-in banner shows while signed out).
- **Signing out** keeps the data on the device by default, or optionally wipes it. Signing back in merges again.
- Card snapshots (name, set, image, prices) travel with each row, so a new device can show everything without hitting Scryfall.
  Prices refresh per device with *Refresh prices*.
- **Tables**: `collection_items(user_id, id, card_id, card, qty, foil, condition, added_at, deleted, updated_at, synced_at)` and
  `decks(user_id, id, name, format, cards, card_data, created_at, deleted, updated_at, synced_at)`, both keyed by `(user_id, id)`.

## Project layout

```
index.html            App shell: 5 tab sections, bottom tab bar, bottom-sheet + toast containers
manifest.json         PWA manifest (icons, standalone display, theme)
sw.js                 Service worker: precache shell, cache images & OCR engine, network-only API
css/styles.css        All styles (dark theme tokens at the top, safe-area insets, 48px tap targets)
icons/                PNG icons (192, 512, maskable 512, apple-touch 180)
js/
  app.js              Entry: load state, mount views, tab routing (#hash), SW registration
  store.js            State + persistence (IndexedDB → localStorage fallback), collection/deck mutations
  scryfall.js         Rate-limited Scryfall client (~8 req/s queue), slim() card mapper
  ui.js               DOM helpers: escaping, money, toast, bottom sheet, autocomplete, steppers
  cardsheet.js        Shared card detail sheet (printing picker, foil, qty, condition, add to collection/deck)
  sorting.js          Sort comparators + filters
  decklist.js         Plain-text decklist parser/formatter
  config.js           Supabase URL / anon key / auth feature flags (empty = local-only)
  sync.js             Supabase auth + sync engine (lazy-loads vendor/supabase.js)
  synccore.js         Pure merge logic: rows ↔ local state, last-write-wins, tombstones (unit-tested)
  ocr.js              Tesseract.js wrapper: lazy load, image preprocessing, title cleanup
  names.js            Local fuzzy matching against Scryfall's card-name catalog (for OCR results)
  views/
    search.js  scanner.js  collection.js  decks.js  settings.js
    account.js        Account panel, sign-in banner, sync status chip, password sheet
vendor/tesseract/     Tesseract.js v7 + WASM core + English model (loaded only when scanning)
vendor/supabase.js    supabase-js v2 UMD build (loaded only when sync is configured)
supabase/schema.sql   Database schema + RLS policies for cloud sync
dev/                  Tests (e2e, sync e2e, sync unit), local Supabase mock, icon generator, sample card images
screenshots/          Phone-size screenshots
```

### Data model (IndexedDB `spellbook` → store `kv` → key `state`)

```js
{
  cards:      { [scryfallId]: SlimCard },   // shared cache; prices live here, plus `prev` prices from the last refresh
  collection: [{ uid, cardId, qty, foil, condition, added }],
  decks:      [{ id, name, format, created, updated, cards: [{ cardId, qty, section: 'main'|'side'|'commander' }] }],
  meta:       { lastRefresh, lastRefreshTotal },
  tombstones: { collection: { [uid]: deletedAt }, decks: { [id]: deletedAt } },          // sync bookkeeping
  sync:       { userId, cursor: { collection_items, decks }, dirty: { collection: {}, decks: {} } }
}
```

Views re-render through `store.subscribe()` whenever a mutation calls `store.save()`.
Mutations must timestamp records so they sync: use the store helpers (`addToCollection`, `updateEntry`, `removeEntry`,
`createDeck`, `updateDeck`, `addToDeck`, …), or call `touchEntry(e)` / `touchDeck(d)` before `save()`.

### Common changes

- **Add a tab**: add `<section id="view-x" class="view" data-view="x">` and a `.tab` button in `index.html`,
  create `js/views/x.js` exporting `mount(el)` (and optionally `render()`, `show()`, `hide()`), then register it in `VIEWS` in `js/app.js`.
- **Add a sort option**: add an entry to `SORTS` in `js/sorting.js`.
- **Add a format**: edit `FORMATS` in `js/store.js` (deck-size targets are in `TARGET` in `views/decks.js`).
- **Tune the scanner**: the guide box position is `.scan-guide .title-box` in CSS. Crop insets and the match threshold (0.62)
  are in `views/scanner.js`. Image preprocessing is in `ocr.preprocess()`.
- **Sync another kind of record**: add a table to `schema.sql` (same columns, trigger and policies), add row converters plus an
  `applyRemote` branch in `synccore.js`, and add it to `TABLES`.
- **After changing shell files**, bump `VERSION` in `sw.js` so installed apps update. If you add a JS file, also add it to `SHELL_FILES`.

## How the scanner works

1. `getUserMedia({ video: { facingMode: 'environment' } })` streams the rear camera into a `<video>` (object-fit: cover).
2. The yellow box's on-screen rectangle is mapped to video pixels and cropped, with a tight crop first and looser crops on manual taps.
3. `ocr.preprocess` upscales, converts to grayscale, stretches contrast and inverts light-on-dark titles. Tesseract then runs in single-line mode (PSM 7).
4. Matching: local Dice-similarity search over Scryfall's ~35k card names (`/catalog/card-names`, cached in IndexedDB for a week)
   → `/cards/named?exact=`. Manual scans fall back to `/cards/named?fuzzy=` + `/cards/autocomplete`. Alternates appear as chips.
5. Auto mode scans about once a second, skips repeat reads of the same card for 6 s, and only uses the local catalog (no fuzzy API calls) to respect rate limits.

OCR reads the **name only**. The suggested printing is Scryfall's default, so pick the exact set from the dropdown if it matters for price.

## Testing

```bash
cd dev && npm i && npx playwright install chromium
(cd .. && python3 -m http.server 8080 &)
node e2e-test.mjs          # full app, local-only mode (empty config)
node sync-unit-test.mjs    # merge logic, no browser or network needed
```

**Sync end-to-end against a local Supabase stand-in.** This uses real Postgres and PostgREST with the real `schema.sql` and RLS, plus a fake auth server:

```bash
sudo apt-get install -y postgresql && sudo pg_ctlcluster 17 main start
sudo -u postgres psql -c "create database spellbook"
sudo -u postgres psql -d spellbook -f supabase-mock/bootstrap.sql
sudo -u postgres psql -d spellbook -f ../supabase/schema.sql
sudo -u postgres psql -d spellbook -f supabase-mock/rls-test.sql     # RLS / trigger checks
# download a PostgREST binary from https://github.com/PostgREST/postgrest/releases, then (from dev/):
npm i pg && node supabase-mock/server.mjs ./postgrest > /tmp/mock.log &
node sync-e2e.mjs          # two simulated devices + a second user
```

The test runs at an iPhone 13 viewport against live Scryfall. It feeds a fake camera stream (a card image drawn on a canvas)
to check live scanning, photo upload and auto-add. It also covers search, adding cards, sorting and filtering, price refresh, deck import/export,
curve and colors, backup export, persistence across reload, horizontal overflow, and offline loading.

## Credits

Card data, images and prices © [Scryfall](https://scryfall.com) / TCGplayer. OCR by [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0).
Not affiliated with Wizards of the Coast. Magic: The Gathering is © Wizards of the Coast.
