// Turning a written analyst turn into something worth hearing.
//
// The desk hands its raw markdown to the browser's speech synthesiser, so a
// dossier is read aloud as pipes, asterisks and four-decimal figures — the
// "number number number" problem. Nothing about a table is speakable: it is a
// layout, and layout is exactly what voice cannot carry.
//
// This module is the deterministic floor. It strips what cannot be spoken,
// says numbers the way a person would, and keeps only the opening claim. The
// model path in routes/voice.js does the better job when a brain is available;
// this is what answers when it is not, and it never fails or costs anything.

const MAX_SENTENCES = 4;
const MAX_CHARS = 420;

/** "1234567" -> "1.2 million" — magnitudes people say out loud. */
export function humanizeMagnitude(value) {
  const n = Math.abs(value);
  if (n >= 1e12) return `${trimZero(value / 1e12)} trillion`;
  if (n >= 1e9) return `${trimZero(value / 1e9)} billion`;
  if (n >= 1e6) return `${trimZero(value / 1e6)} million`;
  if (n >= 1e4) return `${Math.round(value / 1e3)} thousand`;
  return null;
}

function trimZero(n) {
  return String(Number(n.toFixed(1)));
}

/** Round the way speech does: precision drops as magnitude rises. */
export function speakNumber(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  const big = humanizeMagnitude(n);
  if (big) return big;
  const abs = Math.abs(n);
  if (abs >= 100) return String(Math.round(n));
  if (abs >= 10) return String(Number(n.toFixed(1)));
  return String(Number(n.toFixed(2)));
}

/** Percentages get one decimal at most — "down two point three one" is nobody. */
export function speakPercent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  return String(Number(n.toFixed(1)));
}

/**
 * Rewrite figures as spoken language: currency, percentages, suffixed
 * magnitudes and long decimals.
 */
export function humanizeNumbers(text) {
  let s = String(text);

  // $1.23T / $4.5B / $900M — suffix first, before the plain-currency rule.
  s = s.replace(/\$\s?(\d+(?:\.\d+)?)\s?([TBMK])\b/gi, (_m, num, suffix) => {
    const scale = { t: 'trillion', b: 'billion', m: 'million', k: 'thousand' }[suffix.toLowerCase()];
    return `${Number(num)} ${scale} dollars`;
  });

  // $140.25 / $1,234.56
  s = s.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, (_m, num) => {
    const value = Number(num.replace(/,/g, ''));
    if (!Number.isFinite(value)) return _m;
    const spoken = speakNumber(value);
    return `${spoken} dollar${value === 1 ? '' : 's'}`;
  });

  // Signed percentages carry direction, which is the part that matters.
  s = s.replace(/([+-])\s?(\d+(?:\.\d+)?)\s?%/g, (_m, sign, num) => {
    const word = sign === '-' ? 'down' : 'up';
    return `${word} ${speakPercent(num)} percent`;
  });
  s = s.replace(/(\d+(?:\.\d+)?)\s?%/g, (_m, num) => `${speakPercent(num)} percent`);

  // Bare suffixed magnitudes: 1.2T shares, 900K units.
  s = s.replace(/\b(\d+(?:\.\d+)?)([TBMK])\b/g, (_m, num, suffix) => {
    const scale = { T: 'trillion', B: 'billion', M: 'million', K: 'thousand' }[suffix];
    return scale ? `${Number(num)} ${scale}` : _m;
  });

  // Nobody says "sixty-eight point three two".
  s = s.replace(/\b\d+\.\d{2,}\b/g, (m) => speakNumber(m));

  return s;
}

/**
 * Strip everything that exists for the eye: tables, code, links, citations,
 * emphasis, headings, bullets.
 */
export function stripMarkup(text) {
  let s = String(text || '');

  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  // Table rows and their separator lines — pure layout.
  s = s.replace(/^\s*\|.*\|\s*$/gm, ' ');
  s = s.replace(/^\s*[-:|\s]{4,}$/gm, ' ');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // keep link text, drop the URL
  s = s.replace(/\[\d+\]/g, ' '); // citation markers
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/^#{1,6}\s*/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*\d+\.\s+/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1');
  s = s.replace(/^\s*[-–—]{3,}\s*$/gm, ' ');
  s = s.replace(/[|]/g, ' ');

  s = s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
  // Removing citations and links leaves orphaned punctuation behind — "above
  // the average ." is audibly wrong.
  s = s.replace(/\s+([.,;:!?])/g, '$1');
  s = s.replace(/([–—-])\s*\1+/g, '$1');
  return s.trim();
}

/**
 * Drop the lines that carry no spoken meaning: headings are titles, and the
 * verdict line is already the lead sentence.
 */
function dropStructuralLines(text, { hasVerdict }) {
  return String(text)
    .split('\n')
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .filter((line) => !(hasVerdict && /VERDICT\s*:/i.test(line)))
    .join('\n');
}

function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A verdict line is the one thing worth leading with when present. */
export function extractVerdict(text) {
  const m = String(text || '').match(
    /VERDICT:\**\s*(BUY|HOLD|SELL)\b([^\n]*)/i,
  );
  if (!m) return null;
  const label = m[1].toUpperCase();
  const rest = m[2] || '';
  const conviction = (rest.match(/\((H|M|L)\)/) || [])[1];
  const spoken = { H: 'high', M: 'medium', L: 'low' }[conviction] || null;
  return {
    label,
    conviction: spoken,
    sentence: `The call is ${label.toLowerCase()}${spoken ? `, ${spoken} conviction` : ''}.`,
  };
}

/**
 * Deterministic spoken script: the fallback when no model is configured.
 *
 * @param {string} text Raw turn markdown.
 * @param {{title?:string}} [meta]
 * @returns {string}
 */
export function toSpeech(text, meta = {}) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  const verdict = extractVerdict(raw);
  const body = humanizeNumbers(
    stripMarkup(dropStructuralLines(raw, { hasVerdict: Boolean(verdict) })),
  );
  const picked = sentences(body)
    // Drop residue that reads as noise: bare labels, stubs, disclaimer lines.
    .filter((s) => s.split(/\s+/).length >= 4)
    .filter((s) => !/^not financial advice/i.test(s))
    .filter((s) => !/^source:/i.test(s))
    .slice(0, MAX_SENTENCES);

  const parts = [];
  if (verdict) parts.push(verdict.sentence);
  parts.push(...picked.slice(0, verdict ? MAX_SENTENCES - 1 : MAX_SENTENCES));

  let script = parts.join(' ').trim();

  // A pure data dump leaves nothing speakable behind — say so instead of
  // reading the table back.
  if (!script) {
    script = meta.title
      ? `${meta.title} is ready on screen. There is nothing here that reads well aloud.`
      : 'The detail is on screen — it is a table, so there is nothing worth reading aloud.';
  }

  if (script.length > MAX_CHARS) {
    const cut = script.slice(0, MAX_CHARS);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    script = lastStop > 80 ? cut.slice(0, lastStop + 1) : `${cut.trim()}…`;
  }

  return script.replace(/\s+/g, ' ').trim();
}

/**
 * Is this worth a round trip to the model? Short, clean, prose-only lines
 * (reminders, the desk's own audio brief) are already speech.
 */
export function needsRewrite(text) {
  const s = String(text || '');
  if (s.length > 240) return true;
  if (/[|#*`]|\[\d+\]|https?:\/\//.test(s)) return true;
  const figures = s.match(/\d+(?:\.\d+)?/g) || [];
  if (figures.length >= 4) return true;
  if (figures.some((f) => /\.\d{2,}/.test(f))) return true;
  return false;
}
