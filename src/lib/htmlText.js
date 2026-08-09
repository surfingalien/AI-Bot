// Strip a fetched HTML page down to a title plus readable text. The agent's
// deep-research prompt only ever sees this output, so the goal is signal
// density, not fidelity.

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
};

function decodeEntities(s) {
  return s
    .replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, (m) => {
      const named = ENTITIES[m.toLowerCase()];
      if (named) return named;
      const dec = m.match(/^&#(\d+);$/);
      if (dec) return String.fromCodePoint(Number(dec[1]));
      const hex = m.match(/^&#x([0-9a-f]+);$/i);
      if (hex) return String.fromCodePoint(parseInt(hex[1], 16));
      return m;
    });
}

export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');

  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeEntities(titleMatch ? titleMatch[1] : '').replace(/\s+/g, ' ').trim();

  // Keep block boundaries as spaces so words from adjacent blocks do not fuse.
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)[^>]*>/gi, ' \n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/\s+/g, ' ').trim();

  return { title, text: s };
}
