// Goal condition grammar. Intentionally the same dialect the browser engine's
// evalCond() understands, so a genome exported from the UI keeps working when
// it is handed to the server.
//
//   always
//   at 09:30                  (fires once per day, on or after that local time)
//   price(NVDA) > 140
//   rsi(AAPL) < 30
//   chg(MSFT) <= -3
//   memory contains earnings
//   tasks open

const METRIC_RE = /^(price|rsi|chg)\(([A-Za-z0-9.\-=^$]+)\)\s*(>=|<=|==|=|>|<)\s*(-?\d+(?:\.\d+)?)$/i;
const CROSS_RE =
  /^(price|rsi|chg)\(([A-Za-z0-9.\-=^$]+)\)\s+crosses\s+(above|below)\s+(-?\d+(?:\.\d+)?)$/i;
const TIME_RE = /^at\s+(\d{1,2}):(\d{2})$/i;
const MEMORY_RE = /^memory\s+contains\s+(.+)$/i;

export function parseCondition(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'invalid', error: 'empty condition' };
  if (/^always$/i.test(t)) return { kind: 'always' };

  const time = t.match(TIME_RE);
  if (time) {
    const hh = Number(time[1]);
    const mm = Number(time[2]);
    if (hh > 23 || mm > 59) return { kind: 'invalid', error: 'time out of range' };
    return { kind: 'time', hh, mm };
  }

  const mem = t.match(MEMORY_RE);
  if (mem) return { kind: 'memory', query: mem[1].trim().toLowerCase() };

  if (/^tasks?\s+open$/i.test(t)) return { kind: 'tasksOpen' };

  // Checked before the plain threshold form so "crosses above" is never read
  // as a malformed comparison.
  const cross = t.match(CROSS_RE);
  if (cross) {
    return {
      kind: 'cross',
      metric: cross[1].toLowerCase(),
      symbol: cross[2].toUpperCase().replace(/^\$/, ''),
      direction: cross[3].toLowerCase(),
      value: Number(cross[4]),
    };
  }

  const metric = t.match(METRIC_RE);
  if (metric) {
    return {
      kind: 'metric',
      metric: metric[1].toLowerCase(),
      symbol: metric[2].toUpperCase().replace(/^\$/, ''),
      op: metric[3] === '=' ? '>' : metric[3],
      value: Number(metric[4]),
    };
  }

  return { kind: 'invalid', error: `unrecognised condition: ${t}` };
}

/** Symbols a condition needs live data for. */
export function metricValue(metric, indicators) {
  if (!indicators) return null;
  if (metric === 'price') return indicators.last ?? null;
  if (metric === 'rsi') return indicators.rsi ?? null;
  return indicators.chgPct ?? null;
}

export function conditionSymbols(text) {
  const out = [];
  const re = /(price|rsi|chg)\(([A-Za-z0-9.\-=^$]+)\)/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const sym = m[2].toUpperCase().replace(/^\$/, '');
    if (!out.includes(sym)) out.push(sym);
  }
  return out;
}

function compare(have, op, want) {
  switch (op) {
    case '>':
      return have > want;
    case '>=':
      return have >= want;
    case '<':
      return have < want;
    case '<=':
      return have <= want;
    case '==':
      return have === want;
    default:
      return null;
  }
}

/**
 * Evaluate a parsed condition.
 *
 * @returns {true|false|null} null means "undecidable right now" (no feed, no
 *   data) — the caller reports it rather than treating it as false.
 */
export function evaluateCondition(cond, ctx = {}) {
  const { state = {}, feed = {}, now = new Date(), goal = {} } = ctx;

  switch (cond.kind) {
    case 'always':
      return true;

    case 'time': {
      const today = now.toDateString();
      if (goal.lastFireDay === today) return false;
      const due = now.getHours() * 60 + now.getMinutes() >= cond.hh * 60 + cond.mm;
      return due ? true : false;
    }

    case 'memory': {
      const memory = state.memory || [];
      return memory.some((m) => `${m.k} ${m.v}`.toLowerCase().includes(cond.query));
    }

    case 'tasksOpen': {
      const tasks = state.tasks || [];
      return tasks.some((t) => !t.done);
    }

    case 'metric': {
      const have = metricValue(cond.metric, feed[cond.symbol]?.indicators);
      if (have == null) return null;
      return compare(have, cond.op, cond.value);
    }

    case 'cross': {
      const have = metricValue(cond.metric, feed[cond.symbol]?.indicators);
      if (have == null) return null;

      // A crossing is a transition, so it needs the previous reading. The
      // first sample only establishes the baseline — nothing has crossed yet.
      const previous = goal.lastReading?.[cond.symbol]?.[cond.metric];
      if (previous == null) return null;

      return cond.direction === 'above'
        ? previous <= cond.value && have > cond.value
        : previous >= cond.value && have < cond.value;
    }

    default:
      return null;
  }
}

/**
 * Record the readings a crossing condition will compare against next tick.
 * Kept beside evaluation so the two never disagree about what "previous" means.
 */
export function rememberReadings(cond, goal, feed) {
  if (!cond || (cond.kind !== 'cross' && cond.kind !== 'metric')) return;
  const have = metricValue(cond.metric, feed[cond.symbol]?.indicators);
  if (have == null) return;
  if (!goal.lastReading) goal.lastReading = {};
  if (!goal.lastReading[cond.symbol]) goal.lastReading[cond.symbol] = {};
  goal.lastReading[cond.symbol][cond.metric] = have;
}
