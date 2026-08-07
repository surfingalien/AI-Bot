// A ledger of what the agent claimed, and what actually happened.
//
// The signal engine here has always emitted calls into the void: a BUY with a
// conviction letter, and nothing that ever went back to check. This closes that
// loop. The approach is adapted from the FinSurfing brain's learning cycle,
// whose discipline is the valuable part:
//
//   - Resolve against the bar closest to exactly +7/+30 days from the call, not
//     whatever the price happens to be whenever the job runs.
//   - Check whether price ever entered the entry zone. A fill that never
//     happened is not a win, however well the symbol did afterwards.
//   - Measure against a benchmark. Being up 4% in a week the index rose 6% is
//     not skill.
//   - Compute the statistics in code. A model may narrate them; it may not
//     produce them.
//
// Storage is append-only JSONL: a scorecard you can recompute from the raw
// record is worth more than one you have to trust.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { fetchChart, parseChart, normalizeSymbol } from '../market/yahoo.js';
import { log } from './log.js';

const DAY = 86400000;
const HORIZONS = [7, 30];
const BENCHMARK = 'SPY';

function file() {
  return path.resolve(process.cwd(), config.predictions.file);
}

export function readPredictions() {
  try {
    return fs
      .readFileSync(file(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`prediction ledger unreadable: ${err.message}`);
    return [];
  }
}

function writeAll(records) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, target);
}

/**
 * Record a call. Everything needed to score it later is captured now — a
 * ledger that has to re-derive its own inputs cannot be trusted.
 */
export function logPrediction(entry) {
  const symbol = normalizeSymbol(entry.symbol);
  if (!symbol) return null;

  const record = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    generatedAt: new Date().toISOString(),
    symbol,
    label: String(entry.label || 'HOLD').toUpperCase(),
    conviction: String(entry.conviction || 'L').toUpperCase(),
    score: entry.score ?? null,
    basePrice: Number(entry.basePrice) || null,
    entryLow: Number(entry.entryLow) || null,
    entryHigh: Number(entry.entryHigh) || null,
    stop: Number(entry.stop) || null,
    target: Number(entry.target) || null,
    // Falsifiable conditions in the goal grammar, so a broken thesis can be
    // armed and alerted on rather than merely written down.
    assumptions: Array.isArray(entry.assumptions) ? entry.assumptions.slice(0, 4) : [],
    source: entry.source || 'scan',
    reasons: Array.isArray(entry.reasons) ? entry.reasons.slice(0, 4) : [],
  };

  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(record)}\n`);
  return record;
}

/** Daily bars in the shape the resolver needs. */
async function fetchBars(symbol) {
  try {
    const series = parseChart(await fetchChart(symbol));
    if (!series) return [];
    return series.dates.map((t, i) => ({
      t: t * 1000,
      c: series.closes[i],
      h: series.highs[i],
      l: series.lows[i],
    }));
  } catch (err) {
    log.debug(`bars unavailable for ${symbol}: ${err?.message || err}`);
    return [];
  }
}

/** The close nearest a target date, provided a bar exists near enough to mean it. */
export function nearestClose(bars, targetMs, toleranceDays = 4) {
  if (!bars?.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const b of bars) {
    const dist = Math.abs(b.t - targetMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  if (!best || bestDist > toleranceDays * DAY) return null;
  return best.c;
}

/**
 * Did price ever trade into the entry zone in the window?
 *
 * @returns {boolean|null} null when there are no bars to judge by — unknown is
 *   not the same as no.
 */
export function zoneTouched(bars, fromMs, toMs, low, high) {
  if (low == null || high == null || !bars?.length) return null;
  let sawBars = false;
  for (const b of bars) {
    if (b.t < fromMs || b.t > toMs) continue;
    sawBars = true;
    const lo = b.l ?? b.c;
    const hi = b.h ?? b.c;
    if (lo <= high && hi >= low) return true;
  }
  return sawBars ? false : null;
}

/**
 * Resolve every call old enough to have an answer.
 */
export async function resolveOutcomes() {
  const records = readPredictions();
  if (!records.length) return { resolved: 0, pending: 0 };

  const now = Date.now();
  const due = records.filter((r) => {
    const age = now - new Date(r.generatedAt).getTime();
    return HORIZONS.some((d) => age >= d * DAY && r[`price${d}d`] == null);
  });
  if (!due.length) return { resolved: 0, pending: records.filter((r) => !r.price30d).length };

  const symbols = [...new Set(due.map((r) => r.symbol))];
  const bars = {};
  for (const sym of [...symbols, BENCHMARK]) {
    bars[sym] = await fetchBars(sym);
  }

  let resolved = 0;
  const updated = records.map((record) => {
    const genMs = new Date(record.generatedAt).getTime();
    const age = now - genMs;
    const own = bars[record.symbol];
    if (!own?.length) return record;

    const bench = bars[BENCHMARK] || [];
    const benchBase = nearestClose(bench, genMs);
    const copy = { ...record };

    if (copy.basePrice == null) copy.basePrice = nearestClose(own, genMs);

    for (const days of HORIZONS) {
      const priceKey = `price${days}d`;
      if (age < days * DAY || copy[priceKey] != null) continue;
      const px = nearestClose(own, genMs + days * DAY);
      if (px == null) continue;

      copy[priceKey] = px;
      if (copy.basePrice) {
        copy[`ret${days}d`] = +(((px - copy.basePrice) / copy.basePrice) * 100).toFixed(2);
      }
      const benchPx = nearestClose(bench, genMs + days * DAY);
      if (benchBase && benchPx != null) {
        copy[`benchRet${days}d`] = +(((benchPx - benchBase) / benchBase) * 100).toFixed(2);
      }
      resolved += 1;
    }

    // A call whose entry was never reached did not happen, whatever the price
    // did afterwards.
    if (copy.entered === undefined) {
      copy.entered = zoneTouched(own, genMs, genMs + 7 * DAY, copy.entryLow, copy.entryHigh);
    }
    return copy;
  });

  writeAll(updated);
  log.info(`predictions: resolved ${resolved} outcome(s) at exact horizons`);
  return { resolved, pending: updated.filter((r) => r.price30d == null).length };
}

function rate(rows, predicate) {
  if (!rows.length) return null;
  return +(rows.filter(predicate).length / rows.length).toFixed(3);
}

/**
 * Deterministic scorecard. Every number here is computed from the ledger — a
 * model may read it aloud, but never produce it.
 *
 * A SELL that fell is a win, so direction is respected rather than assuming
 * every call is long.
 */
export function scorecard({ horizon = 30 } = {}) {
  const records = readPredictions();
  const priceKey = `price${horizon}d`;
  const retKey = `ret${horizon}d`;
  const benchKey = `benchRet${horizon}d`;

  const resolved = records.filter((r) => r[priceKey] != null && r[retKey] != null);
  // Only calls that could actually have been taken count toward accuracy.
  const tradeable = resolved.filter((r) => r.entered !== false && r.label !== 'HOLD');

  const directional = (r) => (r.label === 'SELL' ? -r[retKey] : r[retKey]);
  const beatsBench = (r) =>
    r[benchKey] != null && (r.label === 'SELL' ? -r[retKey] > -r[benchKey] : r[retKey] > r[benchKey]);

  const withBench = tradeable.filter((r) => r[benchKey] != null);

  const calibration = {};
  for (const bucket of ['H', 'M', 'L']) {
    const rows = tradeable.filter((r) => r.conviction === bucket);
    if (!rows.length) continue;
    calibration[bucket] = {
      n: rows.length,
      winRate: rate(rows, (r) => directional(r) > 0),
      avgReturn: +(rows.reduce((a, r) => a + directional(r), 0) / rows.length).toFixed(2),
    };
  }

  const byLabel = {};
  for (const label of ['BUY', 'SELL']) {
    const rows = tradeable.filter((r) => r.label === label);
    if (!rows.length) continue;
    byLabel[label] = {
      n: rows.length,
      winRate: rate(rows, (r) => directional(r) > 0),
      avgReturn: +(rows.reduce((a, r) => a + directional(r), 0) / rows.length).toFixed(2),
    };
  }

  return {
    horizonDays: horizon,
    logged: records.length,
    resolved: resolved.length,
    pending: records.length - resolved.length,
    // Distinct from win rate on purpose: a strategy whose entries rarely fill
    // can look accurate while being untradeable.
    fillRate: rate(
      resolved.filter((r) => r.entered !== null && r.label !== 'HOLD'),
      (r) => r.entered === true,
    ),
    tradeable: tradeable.length,
    winRate: rate(tradeable, (r) => directional(r) > 0),
    alphaWinRate: withBench.length ? rate(withBench, beatsBench) : null,
    avgReturn: tradeable.length
      ? +(tradeable.reduce((a, r) => a + directional(r), 0) / tradeable.length).toFixed(2)
      : null,
    avgBenchmark: withBench.length
      ? +(withBench.reduce((a, r) => a + r[benchKey], 0) / withBench.length).toFixed(2)
      : null,
    calibration,
    byLabel,
    // Calibration is the honest headline: if high-conviction calls do not beat
    // low-conviction ones, the conviction letter is decoration.
    calibrated:
      calibration.H && calibration.L ? calibration.H.winRate > calibration.L.winRate : null,
  };
}

/** A written scorecard; the voice layer turns this into something speakable. */
export function scorecardMarkdown(card) {
  const pct = (v) => (v == null ? 'N/A' : `${(v * 100).toFixed(0)}%`);
  const num = (v) => (v == null ? 'N/A' : `${v > 0 ? '+' : ''}${v}%`);

  const lines = [
    `## Prediction scorecard — ${card.horizonDays}-day horizon`,
    '',
    `${card.logged} call(s) logged · ${card.resolved} resolved · ${card.pending} still pending`,
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Entries actually filled | ${pct(card.fillRate)} |`,
    `| Win rate (filled only) | ${pct(card.winRate)} |`,
    `| Beat the benchmark | ${pct(card.alphaWinRate)} |`,
    `| Average return | ${num(card.avgReturn)} |`,
    `| Benchmark over the same windows | ${num(card.avgBenchmark)} |`,
  ];

  if (Object.keys(card.calibration).length) {
    lines.push('', '| Conviction | Calls | Win rate | Avg return |', '|---|---|---|---|');
    for (const [bucket, s] of Object.entries(card.calibration)) {
      lines.push(`| ${bucket} | ${s.n} | ${pct(s.winRate)} | ${num(s.avgReturn)} |`);
    }
    if (card.calibrated === false) {
      lines.push(
        '',
        '_High-conviction calls are not outperforming low-conviction ones — the conviction letter is not carrying information yet._',
      );
    }
  }

  if (!card.resolved) {
    lines.push('', '_Nothing has aged into a resolution yet. The first scores land seven days after the first call._');
  }
  lines.push('', '_Rules-based scoring of past calls. Not financial advice._');
  return lines.join('\n');
}
