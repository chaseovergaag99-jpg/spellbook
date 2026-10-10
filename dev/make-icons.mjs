import { chromium } from 'playwright';
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a1f5c"/><stop offset="1" stop-color="#0f1115"/></linearGradient>
<linearGradient id="card" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b3a8ff"/><stop offset="1" stop-color="#6d5ce8"/></linearGradient></defs>
<rect width="512" height="512" fill="url(#bg)"/>
<g transform="translate(256 256) scale(${pad}) translate(-256 -256)">
<rect x="150" y="120" width="190" height="265" rx="18" fill="#3b3470" transform="rotate(-12 245 252)"/>
<rect x="175" y="110" width="190" height="265" rx="18" fill="url(#card)" stroke="#fff" stroke-opacity=".6" stroke-width="4"/>
<rect x="192" y="128" width="156" height="26" rx="6" fill="#fff" fill-opacity=".85"/>
<circle cx="270" cy="255" r="58" fill="#0f1115" fill-opacity=".35"/>
<path d="M270 205 L285 245 L325 255 L285 265 L270 305 L255 265 L215 255 L255 245 Z" fill="#fff"/>
</g></svg>`;
const b = await chromium.launch(); const p = await b.newPage();
for (const [name, size, pad] of [['icon-192', 192, 1], ['icon-512', 512, 1], ['apple-touch-icon', 180, 1], ['maskable-512', 512, 0.78]]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<html><body style="margin:0">${svg(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await p.screenshot({ path: `${new URL('../icons/', import.meta.url).pathname}${name}.png`, clip: { x: 0, y: 0, width: size, height: size } });
}
await b.close(); console.log('icons ok');
