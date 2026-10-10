/**
 * decklist.js — plain-text decklist parse/format ("4 Lightning Bolt").
 *
 * Understands:
 *   4 Lightning Bolt            4x Lightning Bolt
 *   4 Lightning Bolt (M10) 146  (Arena/MTGO style, set code optional)
 *   SB: 2 Duress                section headers: Commander / Deck / Main / Sideboard / Companion
 *   A blank line (with no headers in the list) switches main → sideboard (MTGO style).
 *   Lines starting with // or # are comments.
 */

const HEADER = /^(commander|commanders|deck|main|mainboard|maindeck|sideboard|side|companion|maybeboard)\s*:?$/i;
const LINE = /^(?:(\d+)\s*x?\s+)?(.+?)(?:\s+\(([A-Za-z0-9]{2,6})\)(?:\s+[\w★-]+)?)?(?:\s+\*[A-Z]+\*)?\s*$/;

export function parseDecklist(text) {
  const out = [];
  let section = 'main';
  const hasHeaders = text.split(/\r?\n/).some((l) => HEADER.test(l.trim()));
  let sawMain = false;
  for (let raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) { if (!hasHeaders && sawMain) section = 'side'; continue; }
    if (line.startsWith('//') || line.startsWith('#')) continue;
    const h = line.match(HEADER);
    if (h) {
      const k = h[1].toLowerCase();
      section = k.startsWith('commander') ? 'commander' : k.startsWith('side') ? 'side' : k === 'maybeboard' ? 'skip' : k === 'companion' ? 'side' : 'main';
      continue;
    }
    if (section === 'skip') continue;
    let sec = section;
    if (/^SB:\s*/i.test(line)) { sec = 'side'; line = line.replace(/^SB:\s*/i, ''); }
    const m = line.match(LINE);
    if (!m) continue;
    const qty = m[1] ? parseInt(m[1], 10) : 1;
    const name = m[2].trim();
    if (!name || qty <= 0) continue;
    out.push({ qty, name, set: m[3]?.toLowerCase() || null, section: sec });
    if (sec === 'main') sawMain = true;
  }
  return out;
}

/** Format a deck as text with Commander / Deck / Sideboard sections. */
export function formatDecklist(deck, cards, { withSet = false } = {}) {
  const line = (c) => {
    const card = cards[c.cardId];
    return `${c.qty} ${card?.name ?? '?'}${withSet && card ? ` (${card.set.toUpperCase()}) ${card.collector_number}` : ''}`;
  };
  const by = (s) => deck.cards.filter((c) => c.section === s).sort((a, b) => (cards[a.cardId]?.name || '').localeCompare(cards[b.cardId]?.name || ''));
  const parts = [];
  const cmd = by('commander'), main = by('main'), side = by('side');
  if (cmd.length) parts.push('Commander\n' + cmd.map(line).join('\n'));
  parts.push('Deck\n' + main.map(line).join('\n'));
  if (side.length) parts.push('Sideboard\n' + side.map(line).join('\n'));
  return parts.join('\n\n') + '\n';
}
