/**
 * ocr.js — client-side OCR with Tesseract.js (vendored in /vendor/tesseract).
 *
 * The library, WASM core and English model (~7 MB total) load lazily the first
 * time the scanner is used; the service worker then caches them for offline
 * use, and Tesseract also keeps the language model in IndexedDB.
 */

let workerPromise = null;
const abs = (p) => new URL(p, document.baseURI).href;

function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.Tesseract) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load OCR engine'));
    document.head.appendChild(s);
  });
}

/** Get (or lazily create) the singleton Tesseract worker. */
export function getWorker(onStatus) {
  if (!workerPromise) {
    workerPromise = (async () => {
      onStatus?.('Loading OCR engine…');
      await loadScript(abs('vendor/tesseract/tesseract.min.js'));
      const worker = await window.Tesseract.createWorker('eng', 1 /* LSTM only */, {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract/core'),
        langPath: abs('vendor/tesseract/lang'),
        workerBlobURL: false,
        logger: (m) => { if (m.status && m.progress < 1) onStatus?.(`${m.status} ${Math.round(m.progress * 100)}%`); },
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '7', // single text line (a card title)
        preserve_interword_spaces: '1',
      });
      onStatus?.('');
      return worker;
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

/**
 * Prepare a crop for OCR: upscale to ~110px tall, grayscale, stretch
 * contrast and invert light-on-dark titles. Returns a canvas.
 */
export function preprocess(source, sx, sy, sw, sh) {
  const scale = Math.max(1, 110 / sh);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  let min = 255, max = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = y; if (y < min) min = y; if (y > max) max = y; sum += y;
  }
  const mean = sum / (d.length / 4);
  const invert = mean < 110;
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    let y = ((d[i] - min) / range) * 255;
    if (invert) y = 255 - y;
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** OCR a canvas; returns { text, confidence }. */
export async function recognize(canvas, onStatus) {
  const w = await getWorker(onStatus);
  const { data } = await w.recognize(canvas);
  return { text: data.text || '', confidence: data.confidence || 0 };
}

/** OCR a canvas as a block of text (used for photo fallback); returns lines. */
export async function recognizeLines(canvas, onStatus) {
  const w = await getWorker(onStatus);
  await w.setParameters({ tessedit_pageseg_mode: '11' }); // sparse text
  try {
    const { data } = await w.recognize(canvas);
    return (data.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  } finally {
    await w.setParameters({ tessedit_pageseg_mode: '7' });
  }
}

/** Strip OCR noise (mana symbols, punctuation) from a title line. */
export function cleanTitle(raw) {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^A-Za-zÀ-ÿ0-9 ,'\-]/g, ' ')   // keep letters, digits, comma, apostrophe, hyphen
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Candidate name strings to try against Scryfall, most-literal first:
 * the cleaned text, then with short leading/trailing junk tokens removed
 * (mana symbols are often read as "O", "ee", "@" etc.).
 */
export function titleCandidates(raw) {
  const base = cleanTitle(raw);
  const noTail = base.replace(/(\s+\S{1,2})+$/g, '').trim();
  const noBoth = noTail.replace(/^(\S{1,2}\s+)+/g, '').trim();
  const fewer = noBoth.split(' ').length > 2 ? noBoth.split(' ').slice(0, -1).join(' ') : '';
  return [...new Set([base, noTail, noBoth, fewer])].filter((s) => s.replace(/[^A-Za-z]/g, '').length >= 3);
}
