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
  if (looksLikeCommand(said)) {
    return { command: said, rewritten: false, source: 'already-command' };
  }

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
