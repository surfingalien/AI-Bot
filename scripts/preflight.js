#!/usr/bin/env node
//
// Checks every outbound dependency this server has, in one command, and says
// what to do about each failure.
//
//   node scripts/preflight.js              # check everything configured
//   node scripts/preflight.js --send       # also send a real test email
//
// Exits non-zero if anything that is *configured* is failing. Something that
// is simply not set up is reported as skipped, never as broken — the two need
// different fixes and conflating them wastes an afternoon.
//
// It also names the specific failure mode that looks like a bug and is not: a
// network policy that allows some hosts and refuses others returns 403 from
// somewhere that is not the destination, which reads as "the API rejected us"
// when nothing ever reached the API.

import { config, brainConfigured } from '../src/config.js';
import { fetchChart, fetchQuote, parseChart } from '../src/market/yahoo.js';
import { computeIndicators } from '../src/lib/indicators.js';
import { probe } from '../src/brain/client.js';
import { emailConfigured, sendEmail } from '../src/lib/email.js';
import { sendNotification } from '../src/lib/notify.js';
import { diagnoseFailure } from '../src/lib/reachability.js';

const SEND = process.argv.includes('--send');

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const results = [];

function diagnose(message, ms, host) {
  const { message: text, advice } = diagnoseFailure(message, ms, host);
  return advice ? `${text}\n      ${advice}` : text;
}

async function check(name, { host, configured = true, hint = '', fn }) {
  if (!configured) {
    results.push({ name, state: 'skip', hint });
    console.log(`${yellow('○')} ${name} ${dim('— not configured')}`);
    if (hint) console.log(dim(`      ${hint}`));
    return;
  }
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ name, state: 'ok', ms });
    console.log(`${green('✓')} ${name} ${dim(`(${ms}ms)`)}`);
    if (detail) console.log(dim(`      ${detail}`));
  } catch (err) {
    const ms = Date.now() - started;
    results.push({ name, state: 'fail', ms });
    console.log(`${red('✗')} ${name} ${dim(`(${ms}ms)`)}`);
    console.log(red(`      ${diagnose(err?.message || String(err), ms, host)}`));
    if (hint) console.log(dim(`      ${hint}`));
  }
}

console.log('\nSurfingAlien preflight — every outbound dependency, one pass.\n');

await check('Market feed · chart', {
  host: new URL(config.market.base).host,
  hint: 'Set YAHOO_BASE to a mirror if Yahoo is unreachable from here.',
  fn: async () => {
    const series = parseChart(await fetchChart('AAPL'));
    if (!series) throw new Error('chart returned too few usable bars to compute anything');
    const ind = computeIndicators(series);
    if (!(ind.last > 0)) throw new Error('indicators came back implausible');
    return `${series.closes.length} bars · last ${ind.last.toFixed(2)} · RSI ${ind.rsi?.toFixed(1)} · ${ind.trend}`;
  },
});

await check('Market feed · quote', {
  host: new URL(config.market.base).host,
  fn: async () => {
    const quote = await fetchQuote('AAPL');
    const q = quote?.quoteResponse?.result?.[0];
    if (!q) throw new Error('no quoteResponse.result[0] in the payload');
    const source = quote.source || 'v7';
    return (
      `via ${source}${quote.partial ? ' — partial, fundamentals unavailable (UNVERIFIED is correct)' : ''}` +
      ` · ${q.shortName || q.symbol} ${q.regularMarketPrice ?? '?'}`
    );
  },
});

await check('Model brain', {
  host: config.brain.base ? new URL(config.brain.base).host : 'unset',
  configured: brainConfigured(),
  hint: 'Set BRAIN_BASE and BRAIN_KEY to enable synthesis, spoken briefs and intent.',
  fn: async () => {
    const result = await probe();
    if (!result.ok) throw new Error(result.error || 'probe failed');
    return `${config.brain.model} answered`;
  },
});

await check('Email', {
  host: config.email.resendKey ? new URL(config.email.resendUrl).host : config.email.smtp.host,
  configured: emailConfigured(),
  hint: 'Set RESEND_API_KEY (and EMAIL_TO), or SMTP_HOST/USER/PASS with `npm install nodemailer`.',
  fn: async () => {
    if (!config.email.to) throw new Error('a provider is configured but EMAIL_TO is empty');
    if (!SEND) {
      return `provider ready, recipient ${config.email.to} — re-run with --send to deliver a test`;
    }
    const result = await sendEmail({
      subject: 'SurfingAlien preflight',
      markdown:
        '## Preflight\n\nIf you are reading this, email delivery works.\n\n' +
        '| Check | Result |\n|---|---|\n| Delivery | OK |\n',
    });
    if (!result.sent) throw new Error(result.reason || 'delivery failed');
    return `test message delivered to ${config.email.to} via ${result.via}`;
  },
});

await check('Alert webhook', {
  host: config.notify.webhook ? new URL(config.notify.webhook).host : 'unset',
  configured: Boolean(config.notify.webhook),
  hint: 'Set NOTIFY_WEBHOOK to receive alerts from fired goals.',
  fn: async () => {
    if (!SEND) return 'webhook configured — re-run with --send to post a test alert';
    const result = await sendNotification('SurfingAlien preflight: alerts are working.', '', {
      voice: false,
    });
    if (!result.delivered) throw new Error(result.reason || 'delivery failed');
    return 'test alert delivered';
  },
});

const failed = results.filter((r) => r.state === 'fail');
const skipped = results.filter((r) => r.state === 'skip');

console.log('');
if (failed.length) {
  console.log(red(`${failed.length} configured dependenc${failed.length === 1 ? 'y is' : 'ies are'} failing:`));
  for (const f of failed) console.log(`  - ${f.name}`);
  console.log(
    dim('\nNothing above is a code path that needs changing — each one is a host this machine'),
  );
  console.log(dim('cannot reach, or a credential that is missing.'));
  process.exit(1);
}

console.log(green('Everything configured is reachable.'));
if (skipped.length) {
  console.log(dim(`${skipped.length} optional dependenc${skipped.length === 1 ? 'y' : 'ies'} not set up: ${skipped.map((s) => s.name).join(', ')}`));
}
if (!SEND) console.log(dim('Re-run with --send to actually deliver a test email and alert.'));
