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
  ocr.js              Tesseract.js wrapper: lazy load, image preprocessing, title cleanup
  names.js            Local fuzzy matching against Scryfall's card-name catalog (for OCR results)
  views/
    search.js  scanner.js  collection.js  decks.js  settings.js
vendor/tesseract/     Tesseract.js v7 + WASM core + English model (loaded only when scanning)
dev/                  Playwright end-to-end test, icon generator, sample card images
screenshots/          Phone-size screenshots
```

### Data model (IndexedDB `spellbook` → store `kv` → key `state`)

```js
{
  cards:      { [scryfallId]: SlimCard },   // shared cache; prices live here, plus `prev` prices from the last refresh
  collection: [{ uid, cardId, qty, foil, condition, added }],
  decks:      [{ id, name, format, created, updated, cards: [{ cardId, qty, section: 'main'|'side'|'commander' }] }],
  meta:       { lastRefresh, lastRefreshTotal }
}
```

Views re-render through `store.subscribe()` whenever a mutation calls `store.save()`.

### Common changes

- **Add a tab**: add `<section id="view-x" class="view" data-view="x">` and a `.tab` button in `index.html`,
  create `js/views/x.js` exporting `mount(el)` (and optionally `render()`, `show()`, `hide()`), then register it in `VIEWS` in `js/app.js`.
- **Add a sort option**: add an entry to `SORTS` in `js/sorting.js`.
- **Add a format**: edit `FORMATS` in `js/store.js` (deck-size targets are in `TARGET` in `views/decks.js`).
- **Tune the scanner**: the guide box position is `.scan-guide .title-box` in CSS. Crop insets and the match threshold (0.62)
  are in `views/scanner.js`. Image preprocessing is in `ocr.preprocess()`.
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
node e2e-test.mjs
```

The test runs at an iPhone 13 viewport against live Scryfall. It feeds a fake camera stream (a card image drawn on a canvas)
to check live scanning, photo upload and auto-add. It also covers search, adding cards, sorting and filtering, price refresh, deck import/export,
curve and colors, backup export, persistence across reload, horizontal overflow, and offline loading.

## Credits

Card data, images and prices © [Scryfall](https://scryfall.com) / TCGplayer. OCR by [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0).
Not affiliated with Wizards of the Coast. Magic: The Gathering is © Wizards of the Coast.
