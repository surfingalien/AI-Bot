import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractVerdict,
  humanizeMagnitude,
  humanizeNumbers,
  looksLikeRepeat,
  needsRewrite,
  speakNumber,
  stripMarkup,
  toSpeech,
} from '../src/lib/speech.js';

test('magnitudes become words people say', () => {
  assert.equal(humanizeMagnitude(2.4e12), '2.4 trillion');
  assert.equal(humanizeMagnitude(3.51e9), '3.5 billion');
  assert.equal(humanizeMagnitude(1.2e6), '1.2 million');
  assert.equal(humanizeMagnitude(45000), '45 thousand');
  assert.equal(humanizeMagnitude(842), null, 'small numbers stay as they are');
});

test('precision drops as magnitude rises, the way speech does', () => {
  assert.equal(speakNumber('142.6234'), '143');
  assert.equal(speakNumber('68.3129'), '68.3');
  assert.equal(speakNumber('4.2871'), '4.29');
  assert.equal(speakNumber('2400000000'), '2.4 billion');
});

test('currency is spoken, not spelled', () => {
  assert.equal(humanizeNumbers('$142.6234'), '143 dollars');
  assert.equal(humanizeNumbers('$1,234.56'), '1235 dollars');
  assert.equal(humanizeNumbers('$2.4T'), '2.4 trillion dollars');
  assert.equal(humanizeNumbers('$900M market cap'), '900 million dollars market cap');
});

test('signed percentages carry direction and round to one decimal', () => {
  assert.equal(humanizeNumbers('-2.31%'), 'down 2.3 percent');
  assert.equal(humanizeNumbers('+12.4531%'), 'up 12.5 percent');
  assert.equal(humanizeNumbers('RSI at 68.3129'), 'RSI at 68.3');
  assert.equal(humanizeNumbers('volatility 41.2%'), 'volatility 41.2 percent');
});

test('markup that only exists for the eye is removed', () => {
  const md = [
    '## NVDA — Dossier',
    '| Metric | Value |',
    '|---|---|',
    '| Last | $142.62 |',
    '',
    '**Momentum** is positive [1], see [the filing](https://example.com/10k).',
    '- above the 200-day average',
  ].join('\n');
  const out = stripMarkup(md);

  assert.doesNotMatch(out, /[|*#]/);
  assert.doesNotMatch(out, /https?:/);
  assert.doesNotMatch(out, /\[1\]/);
  assert.match(out, /NVDA — Dossier/);
  assert.match(out, /Momentum is positive/);
  assert.match(out, /the filing/, 'link text survives, the URL does not');
});

test('a verdict line is recognised and spoken as the lead', () => {
  const v = extractVerdict('**VERDICT:** BUY (M) - entry $142.62 - stop $131.40');
  assert.equal(v.label, 'BUY');
  assert.equal(v.conviction, 'medium');
  assert.equal(v.sentence, 'The call is buy, medium conviction.');
  assert.equal(extractVerdict('no call here'), null);
});

test('a dossier becomes a short spoken script that leads with the call', () => {
  const dossier = [
    '## NVDA / Data Dossier',
    '| Metric | Value | Metric | Value |',
    '|---|---|---|---|',
    '| Last | $142.6234 | Trend | BULL |',
    '| RSI(14) | 68.3129 | MACD hist | 0.4412 |',
    '',
    'Momentum remains constructive with price 12.4531% above the 200-day average.',
    'Valuation is stretched against the five-year median [2].',
    '',
    '**VERDICT:** BUY (M) - entry $142.62 - stop $131.40 - target $168.90',
    '_Not financial advice._',
  ].join('\n');

  const script = toSpeech(dossier);

  assert.match(script, /^The call is buy, medium conviction\./);
  assert.doesNotMatch(script, /[|*#]/, 'no layout characters survive');
  assert.doesNotMatch(script, /\d+\.\d{2,}/, 'no four-decimal figures survive');
  assert.doesNotMatch(script, /\[\d\]/);
  assert.match(script, /up 12\.5 percent|12\.5 percent/);
  assert.ok(script.length <= 420);
  assert.ok(script.split(/(?<=[.!?])\s+/).length <= 4);

  // The heading is a title, not a sentence, and the verdict must not be read
  // twice — once as the lead and again as an entry/stop/target recital.
  assert.doesNotMatch(script, /Data Dossier/);
  assert.doesNotMatch(script, /VERDICT/i);
  assert.doesNotMatch(script, /entry .* stop .* target/i);
  assert.doesNotMatch(script, /\s\./, 'no orphaned punctuation from stripped citations');
});

test('a table with no prose says so rather than reading the table', () => {
  const table = ['| Symbol | Price |', '|---|---|', '| NVDA | $142.62 |', '| AAPL | $221.10 |'].join(
    '\n',
  );
  const script = toSpeech(table, { title: 'Market scan' });

  assert.match(script, /Market scan is ready on screen/);
  assert.doesNotMatch(script, /142/);
});

test('disclaimer and source lines are not read aloud', () => {
  const script = toSpeech(
    'Revenue grew across every segment this quarter.\nNot financial advice, education only.\nSource: Yahoo Finance, 2026-08-05.',
  );
  assert.match(script, /Revenue grew/);
  assert.doesNotMatch(script, /financial advice/i);
  assert.doesNotMatch(script, /Source:/i);
});

test('empty input yields nothing to speak', () => {
  assert.equal(toSpeech(''), '');
  assert.equal(toSpeech(null), '');
});

test('needsRewrite spares text that is already speech', () => {
  assert.equal(needsRewrite('Reminder: call the board at four.'), false);
  assert.equal(needsRewrite('Mission complete. Three agents reported.'), false);

  assert.equal(needsRewrite('| Metric | Value |'), true, 'tables');
  assert.equal(needsRewrite('**bold** claim'), true, 'markup');
  assert.equal(needsRewrite('See [1] and https://example.com'), true, 'citations and links');
  assert.equal(needsRewrite('Price 142.6234 today'), true, 'long decimals');
  assert.equal(needsRewrite('1 2 3 4 5 figures here'), true, 'number soup');
  assert.equal(needsRewrite('x'.repeat(300)), true, 'long passages');
});

test('a restatement is recognised however it is worded', () => {
  // The spoken lead and the written brief are produced independently — the
  // lead is the answer's own opening, the brief a summary written afterwards —
  // so a repeat has to be recognised by what it says, not by matching text.
  const lead = 'Nvidia still screens as a buy, with momentum intact.';

  assert.equal(looksLikeRepeat('Nvidia still screens as a buy with momentum intact.', lead), true);
  assert.equal(looksLikeRepeat('Nvidia remains a buy; momentum is intact.', lead), true, 'reworded');

  // And a brief that opens with something else keeps it: the listener gets no
  // second chance at a sentence nobody said.
  assert.equal(looksLikeRepeat('Earnings land on Thursday after the close.', lead), false);
  assert.equal(looksLikeRepeat('Valuation is the caveat worth watching.', lead), false);
});

test('shared filler is not mistaken for shared meaning', () => {
  // Two unrelated sentences share "the", "is", "that". Counting those would
  // silently drop briefs that had nothing to do with the lead.
  assert.equal(
    looksLikeRepeat('The position is the one that has been there.', 'The risk is that this has been the case.'),
    false,
  );
  assert.equal(looksLikeRepeat('Buy.', 'Buy.'), false, 'too short to judge either way');
});
