// Turning what someone said into what the desk understands.
//
// The desk routes spoken commands by keyword, so "how's my portfolio doing"
// hits nothing while "positions" works. Rather than teach the operator the
// syntax, translate: the model maps a transcript onto the command vocabulary
// the desk already has, and anything it cannot place passes through untouched.
//
// Passing through is the important default. A wrong rewrite is worse than no
// rewrite — it silently runs the wrong command — so this only replaces a
// transcript when the mapping is confident and lands on a known verb.

import { brainConfigured } from '../config.js';
import { complete } from '../brain/client.js';
import { log } from './log.js';

// What the desk can actually be told. Mirrors the engine's routing surface;
// the model may only answer with one of these shapes.
export const COMMAND_VOCABULARY = [
  { form: 'full equity dossier on <TICKER>', use: 'analysis of one company' },
  { form: 'compare <TICKER> vs <TICKER>', use: 'relative comparison' },
  { form: 'earnings decode <TICKER>', use: 'a specific earnings report' },
  { form: 'DCF value <TICKER>', use: 'valuation' },
  { form: 'deep research <topic>', use: 'anything needing sources from the web' },
  { form: 'backtest <TICKER> momentum strategy', use: 'testing a rule against history' },
  { form: 'positions', use: 'the portfolio, holdings, "how am I doing"' },
  { form: 'scan watchlist', use: 'a sweep of everything watched' },
  { form: 'weekly report', use: 'a written summary of recent work' },
  { form: 'audio brief', use: 'a spoken catch-up' },
  { form: 'remember <fact>', use: 'storing something for later' },
  { form: 'add task <text>', use: 'a to-do' },
  { form: '@chief brief me', use: 'a general status request with no clear subject' },
];

const PROMPT = [
  'You translate spoken requests into commands for a research desk.',
  '',
  'Answer with the command only — no quotes, no explanation, no punctuation beyond the command itself.',
  'If the request does not clearly map to one of these forms, answer exactly: PASS',
  '',
  'Commands:',
  ...COMMAND_VOCABULARY.map((c) => `- ${c.form}  (${c.use})`),
  '',
  'Rules:',
  '- Keep any ticker the speaker used. Uppercase it. Never invent one they did not say.',
  '- Never invent a topic. If the subject is unclear, answer PASS.',
  '- Preserve the speaker\'s wording inside remember/add task/deep research.',
  '- Answer PASS for chatter, greetings, or anything ambiguous.',
].join('\n');

// The leading verbs a rewrite is allowed to produce. A model answering with
// anything else is treated as PASS rather than run.
const ALLOWED_HEADS = [
  'full',
  'compare',
  'earnings',
  'dcf',
  'deep',
  'backtest',
  'positions',
  'scan',
  'weekly',
  'audio',
  'remember',
  'add',
  '@chief',
];

// Spoken names, because nobody says "en-vee-dee-ay".
const NAME_TO_TICKER = {
  nvidia: 'NVDA',
  apple: 'AAPL',
  microsoft: 'MSFT',
  google: 'GOOGL',
  alphabet: 'GOOGL',
  amazon: 'AMZN',
  tesla: 'TSLA',
  meta: 'META',
  facebook: 'META',
  netflix: 'NFLX',
  broadcom: 'AVGO',
  palantir: 'PLTR',
};

function ticker(word) {
  if (!word) return null;
  const clean = word.trim().replace(/^\$/, '').toLowerCase();
  if (NAME_TO_TICKER[clean]) return NAME_TO_TICKER[clean];
  if (/^[a-z]{1,5}$/.test(clean)) return clean.toUpperCase();
  return null;
}

// The phrasings people actually use, matched locally. This exists for latency:
// a model round trip before the desk even starts working is the difference
// between an assistant that feels instant and one that feels slow, and these
// mappings are not the ambiguous cases that need judgement.
const FAST_PATTERNS = [
  [/\b(how(?:'s| is| are)?\s+)?(my\s+)?(portfolio|holdings|positions)\b/i, () => 'positions'],
  [/\b(scan|sweep|check)\b.*\bwatch\s?list\b/i, () => 'scan watchlist'],
  [/\bweekly\s+(report|summary|recap)\b/i, () => 'weekly report'],
  [/\b(audio\s+brief|brief me|catch me up|what did i miss)\b/i, () => 'audio brief'],
  [
    /\b(?:deep\s+)?research\s+(?:on\s+|about\s+|into\s+)?(.+)$/i,
    (m) => `deep research ${m[1].trim()}`,
  ],
  [/\bremember\s+(?:that\s+)?(.+)$/i, (m) => `remember ${m[1].trim()}`],
  [/\badd\s+(?:a\s+)?task\s+(?:to\s+)?(.+)$/i, (m) => `add task ${m[1].trim()}`],
  [
    /\bcompare\s+([A-Za-z$]{2,12})\s+(?:vs\.?|versus|against|and|to)\s+([A-Za-z$]{2,12})\b/i,
    (m) => {
      const a = ticker(m[1]);
      const b = ticker(m[2]);
      return a && b ? `compare ${a} vs ${b}` : null;
    },
  ],
  [
    // Anchored to the end on purpose: "tell me about nvidia" is a dossier,
    // but "tell me about nvidia data centers" is a research question, and
    // collapsing the second into the first silently drops what was asked.
    /\b(?:full\s+)?(?:equity\s+)?(?:dossier|analysis|analyse|analyze|look at|pull up|what about|tell me about)\s+(?:on\s+)?([A-Za-z$]{2,12})\s*[?.!]?\s*$/i,
    (m) => {
      const t = ticker(m[1]);
      return t ? `full equity dossier on ${t}` : null;
    },
  ],
];

/**
 * Local mapping for unambiguous phrasings. Returns null when the model should
 * decide, which is most of the interesting cases.
 */
export function fastIntent(text) {
  const said = String(text || '').trim();
  if (!said) return null;
  for (const [pattern, build] of FAST_PATTERNS) {
    const m = said.match(pattern);
    if (!m) continue;
    const command = build(m);
    if (command && looksLikeCommand(command)) return command;
  }
  return null;
}

// A well-formed command, as opposed to something that merely starts with a
// command verb. The distinction matters in both directions: "scan the
// watchlist" starts like a command but is not one, and "@chief brief me" is a
// valid command the "brief me" fast pattern would otherwise swallow.
export function isExactCommand(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.startsWith('@')) return true; // agent mention — always the operator's own routing
  if (/^(positions|scan watchlist|weekly report|audio brief|digest)$/i.test(t)) return true;
  // The ticker itself must already be uppercase, so "compare apple vs
  // microsoft" still gets its names resolved rather than passing as-is.
  const dossier = t.match(/^full equity dossier on (.+)$/i);
  if (dossier && /^[A-Z0-9.\-^=]{1,15}$/.test(dossier[1].trim())) return true;
  const compare = t.match(/^compare (\S+) vs (\S+)$/i);
  if (compare && [compare[1], compare[2]].every((s) => /^[A-Z0-9.\-]{1,10}$/.test(s))) return true;
  if (/^(earnings decode|dcf value|backtest)\s+\S/i.test(t)) return true;
  if (/^(deep research|remember|add task)\s+\S/i.test(t)) return true;
  return false;
}

export function looksLikeCommand(text) {
  const head = String(text || '')
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase();
  return ALLOWED_HEADS.includes(head);
}

/**
 * @param {string} transcript
 * @returns {Promise<{command:string, rewritten:boolean, source:string, reason?:string}>}
 */
export async function resolveIntent(transcript) {
  const said = String(transcript || '').trim();
  if (!said) return { command: '', rewritten: false, source: 'empty' };

  // Already in the desk's own language — do not touch it. Re-phrasing a
  // working command is pure risk.
  // Already well-formed: never touch it.
  if (isExactCommand(said)) {
    return { command: said, rewritten: false, source: 'already-command' };
  }

  // Then the local patterns — no round trip for the phrasings people repeat
  // daily, which is most of them.
  const fast = fastIntent(said);
  if (fast) return { command: fast, rewritten: fast !== said, source: 'fast-path' };

  if (!brainConfigured()) {
    return { command: said, rewritten: false, source: 'no-brain' };
  }

  try {
    const answer = (
      await complete(
        [
          { role: 'system', content: PROMPT },
          { role: 'user', content: said.slice(0, 500) },
        ],
        { temperature: 0, maxTokens: 60 },
      )
    )
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .split('\n')[0]
      .trim();

    if (!answer || /^PASS$/i.test(answer)) {
      return { command: said, rewritten: false, source: 'pass', reason: 'no confident mapping' };
    }
    if (!looksLikeCommand(answer)) {
      // The model answered with something outside the vocabulary; running it
      // would be a guess.
      return { command: said, rewritten: false, source: 'pass', reason: 'off-vocabulary answer' };
    }
    return { command: answer, rewritten: answer !== said, source: 'model' };
  } catch (err) {
    log.warn(`intent resolution failed, passing through: ${err?.message || err}`);
    return { command: said, rewritten: false, source: 'error', reason: err?.message };
  }
}
