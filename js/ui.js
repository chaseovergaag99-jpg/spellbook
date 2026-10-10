/**
 * ui.js — small DOM helpers shared by every view: escaping, formatting,
 * toast, bottom sheet, autocomplete input, card list/grid templates.
 */
import * as sf from './scryfall.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape text for safe insertion into HTML templates. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const money = (n) => (n == null || isNaN(n) ? '—' : '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const priceStr = (p) => (p ? '$' + parseFloat(p).toFixed(2) : '—');
export function deltaHtml(d) {
  if (d == null || Math.abs(d) < 0.005) return '';
  return `<span class="${d > 0 ? 'delta-up' : 'delta-down'}">${d > 0 ? '▲' : '▼'} ${money(Math.abs(d))}</span>`;
}
export function timeAgo(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(iso).toLocaleDateString();
}

export const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];
export const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless', M: 'Multicolor' };
export const COLOR_VAR = { W: 'var(--mW)', U: 'var(--mU)', B: 'var(--mB)', R: 'var(--mR)', G: 'var(--mG)', C: 'var(--mC)', M: 'var(--mM)' };
export const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4, bonus: 5 };

/** Render a mana cost string like "{2}{R}{R}" as colored pips. */
export function manaHtml(cost) {
  if (!cost) return '';
  return cost.replace(/\{([^}]+)\}/g, (_, s) => {
    const k = s.replace('/P', '').split('/')[0];
    const bg = COLOR_VAR[k] || 'var(--mC)';
    return `<span class="pip" style="background:${bg}">${esc(s.length > 2 ? s.replace('/', '') : s)}</span>`;
  }).replace(/ \/\/ /g, ' / ');
}

/* ---------- toast ---------- */
let toastTimer;
export function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- bottom sheet ---------- */
let onSheetClose = null;
export function openSheet(html, onClose) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false; $('#sheet-backdrop').hidden = false;
  $('#sheet').scrollTop = 0;
  document.body.style.overflow = 'hidden';
  onSheetClose = onClose || null;
  return $('#sheet-body');
}
export function closeSheet() {
  $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true;
  document.body.style.overflow = '';
  const cb = onSheetClose; onSheetClose = null; cb?.();
}
export const sheetOpen = () => !$('#sheet').hidden;
document.addEventListener('click', (e) => { if (e.target.id === 'sheet-backdrop') closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen()) closeSheet(); });

/* ---------- autocomplete ---------- */
/**
 * Wire Scryfall name autocomplete to an <input>. `onPick(name)` fires when a
 * suggestion is chosen. Returns a function to hide the list.
 */
export function attachAutocomplete(input, onPick) {
  const wrap = input.closest('.ac-wrap');
  const list = document.createElement('div');
  list.className = 'ac-list'; list.hidden = true;
  wrap.appendChild(list);
  let timer, seq = 0;
  const hide = () => (list.hidden = true);
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return hide();
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const names = await sf.autocomplete(q);
        if (my !== seq) return;
        if (!names.length) return hide();
        list.innerHTML = names.slice(0, 8).map((n) => `<button type="button" data-name="${esc(n)}">${esc(n)}</button>`).join('');
        list.hidden = false;
      } catch { hide(); }
    }, 220);
  });
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-name]');
    if (!b) return;
    input.value = b.dataset.name; hide(); seq++;
    onPick(b.dataset.name);
  });
  input.addEventListener('blur', () => setTimeout(hide, 200));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { hide(); seq++; } });
  return hide;
}

/* ---------- templates ---------- */
export function gridCard(card, extra = '') {
  return `<button class="grid-card" data-card-id="${esc(card.id)}">
    <div class="img">${card.image ? `<img loading="lazy" src="${esc(card.image)}" alt="${esc(card.name)}">` : ''}</div>
    <div class="meta"><span>${esc(card.set.toUpperCase())}</span>${extra || `<b>${priceStr(card.prices.usd ?? card.prices.usd_foil)}</b>`}</div>
  </button>`;
}

export function stepperHtml(name, value, min = 1) {
  return `<div class="stepper" data-stepper="${name}" data-min="${min}">
    <button type="button" data-step="-1" aria-label="Decrease">−</button>
    <output>${value}</output>
    <button type="button" data-step="1" aria-label="Increase">+</button></div>`;
}
/** Wire all steppers in root; returns getter for values. */
export function wireSteppers(root, onChange) {
  root.querySelectorAll('[data-stepper]').forEach((st) => {
    st.addEventListener('click', (e) => {
      const b = e.target.closest('[data-step]'); if (!b) return;
      const out = st.querySelector('output');
      const v = Math.max(+st.dataset.min, +out.textContent + +b.dataset.step);
      out.textContent = v;
      onChange?.(st.dataset.stepper, v);
    });
  });
  return (name) => +root.querySelector(`[data-stepper="${name}"] output`).textContent;
}

/** Trigger a file download of text content. */
export function download(filename, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
