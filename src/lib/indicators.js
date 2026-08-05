// Technical indicators, kept numerically identical to the browser engine's
// computeInd()/localSignal() so a server-side scan and a UI dossier never
// disagree about the same symbol.

export function sma(arr, period) {
  if (arr.length < period) return null;
  let sum = 0;
  for (let i = arr.length - period; i < arr.length; i++) sum += arr[i];
  return sum / period;
}

export function emaSeries(arr, period) {
  if (arr.length < period) return [];
  const k = 2 / (period + 1);
  const seed = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = [seed];
  for (let i = period; i < arr.length; i++) {
    out.push(arr[i] * k + out[out.length - 1] * (1 - k));
  }
  return out;
}

export function stdev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length;
  return Math.sqrt(variance);
}

export function rsi(closes, period = 14) {
  const n = closes.length;
  if (n < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = n - period; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const rs = loss === 0 ? 100 : gain / loss;
  return 100 - 100 / (1 + rs);
}

/**
 * @param {{closes:number[],highs:number[],lows:number[],dates:number[],meta:object}} series
 */
export function computeIndicators(series) {
  const { closes, highs, lows, dates = [], meta = {} } = series;
  const n = closes.length;
  if (!n) return null;

  const last = closes[n - 1];
  const prev = closes[n - 2];
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);

  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  let macdLine = null;
  let signalLine = null;
  let macdHist = null;
  if (e12.length && e26.length) {
    const m = Math.min(e12.length, e26.length);
    const macdArr = [];
    for (let i = 0; i < m; i++) macdArr.push(e12[e12.length - m + i] - e26[e26.length - m + i]);
    const sig = emaSeries(macdArr, 9);
    if (sig.length) {
      signalLine = sig[sig.length - 1];
      macdLine = macdArr[macdArr.length - 1];
      macdHist = macdLine - signalLine;
    }
  }

  let bbUpper = null;
  let bbLower = null;
  if (s20 != null && n >= 20) {
    const sd = stdev(closes.slice(n - 20));
    bbUpper = s20 + 2 * sd;
    bbLower = s20 - 2 * sd;
  }

  let atr = null;
  if (n >= 15) {
    const trs = [];
    for (let i = n - 14; i < n; i++) {
      trs.push(
        Math.max(
          highs[i] - lows[i],
          Math.abs(highs[i] - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1]),
        ),
      );
    }
    atr = trs.reduce((a, b) => a + b, 0) / 14;
  }

  let hi52 = meta.fiftyTwoWeekHigh;
  let lo52 = meta.fiftyTwoWeekLow;
  if (hi52 == null) {
    hi52 = Math.max(...highs.slice(-252));
    lo52 = Math.min(...lows.slice(-252));
  }

  const retAt = (days) => {
    const i = n - 1 - days;
    if (i < 0) return null;
    return ((last - closes[i]) / closes[i]) * 100;
  };

  let ytd = null;
  const year = new Date().getFullYear();
  for (let i = 0; i < dates.length; i++) {
    if (new Date(dates[i] * 1000).getFullYear() === year) {
      ytd = ((last - closes[i]) / closes[i]) * 100;
      break;
    }
  }

  const rets = [];
  for (let i = 1; i < n; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const vol = stdev(rets) * Math.sqrt(252) * 100;

  let trend = 'MIXED';
  if (s200 != null && s50 != null) {
    if (last > s50 && s50 > s200) trend = 'BULL';
    else if (last < s50 && s50 < s200) trend = 'BEAR';
  }

  return {
    n,
    last,
    prev,
    chgPct: prev ? ((last - prev) / prev) * 100 : 0,
    s20,
    s50,
    s200,
    rsi: rsi(closes, 14),
    macdLine,
    signalLine,
    macdHist,
    bbMid: s20,
    bbUpper,
    bbLower,
    atr,
    hi52,
    lo52,
    m1: retAt(21),
    m3: retAt(63),
    m6: retAt(126),
    y1: retAt(252),
    ytd,
    vol,
    trend,
  };
}

/**
 * Rules-based BUY/HOLD/SELL scoring. Deliberately boring and explainable —
 * every point is attributable to a named driver.
 */
export function localSignal(ind) {
  let score = 0;
  const reasons = [];

  if (ind.s200 != null) {
    if (ind.last > ind.s200) {
      score += 1;
      reasons.push('price above 200-DMA');
    } else {
      score -= 1;
      reasons.push('price below 200-DMA');
    }
  }
  if (ind.s50 != null) {
    if (ind.last > ind.s50) {
      score += 1;
      reasons.push('above 50-DMA');
    } else {
      score -= 1;
      reasons.push('below 50-DMA');
    }
  }
  if (ind.s50 != null && ind.s200 != null) {
    if (ind.s50 > ind.s200) {
      score += 1;
      reasons.push('50>200');
    } else {
      score -= 1;
      reasons.push('50<200');
    }
  }
  if (ind.rsi != null) {
    if (ind.rsi < 30) {
      score += 1;
      reasons.push('RSI oversold');
    } else if (ind.rsi > 70) {
      score -= 1;
      reasons.push('RSI overbought');
    } else {
      reasons.push('RSI neutral');
    }
  }
  if (ind.macdHist != null) {
    if (ind.macdHist > 0) {
      score += 1;
      reasons.push('MACD hist +');
    } else {
      score -= 1;
      reasons.push('MACD hist -');
    }
  }
  if (ind.m1 != null) score += ind.m1 > 0 ? 1 : -1;

  let label = 'HOLD';
  let cls = 'hold';
  if (score >= 4) {
    label = 'BUY';
    cls = 'buy';
  } else if (score <= 1) {
    label = 'SELL';
    cls = 'sell';
  }

  const conv = Math.abs(score) >= 5 ? 'H' : Math.abs(score) >= 3 ? 'M' : 'L';
  const entry = ind.last;
  const stop = ind.atr ? ind.last - 2 * ind.atr : ind.last * 0.94;
  const target = ind.atr ? ind.last + 3 * ind.atr : ind.last * 1.12;
  const risk = ind.vol > 55 ? 8 : ind.vol > 40 ? 6 : ind.vol > 25 ? 4 : 3;

  return { label, cls, conv, score, reasons, entry, stop, target, risk };
}
