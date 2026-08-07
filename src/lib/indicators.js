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

/**
 * Wilder's smoothed RSI — the standard definition, and what most charting
 * packages show.
 *
 * The desk computes RSI as a simple average over the last 14 changes, so the
 * two disagree; both are reported rather than one silently replacing the other,
 * because a server number that contradicts the number on screen is worse than
 * either definition being "wrong".
 */
export function rsiWilder(closes, period = 14) {
  const n = closes.length;
  if (n < period + 1) return null;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;

  // Smooth forward over the rest of the series rather than restarting.
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }

  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/**
 * Average Directional Index — trend *strength*, independent of direction.
 *
 * The existing score reads direction from moving averages but has no way to
 * say "this trend is barely there", which is when its own signals are least
 * worth acting on.
 */
export function adx(highs, lows, closes, period = 14) {
  const n = closes.length;
  if (n < period * 2) return null;

  let smoothTr = 0;
  let smoothPlus = 0;
  let smoothMinus = 0;
  const dxs = [];

  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );

    if (i <= period) {
      smoothTr += tr;
      smoothPlus += plusDM;
      smoothMinus += minusDM;
    } else {
      smoothTr = smoothTr - smoothTr / period + tr;
      smoothPlus = smoothPlus - smoothPlus / period + plusDM;
      smoothMinus = smoothMinus - smoothMinus / period + minusDM;
    }

    if (i >= period && smoothTr > 0) {
      const plusDI = (smoothPlus / smoothTr) * 100;
      const minusDI = (smoothMinus / smoothTr) * 100;
      const sum = plusDI + minusDI;
      if (sum > 0) dxs.push((Math.abs(plusDI - minusDI) / sum) * 100);
    }
  }

  if (dxs.length < period) return null;
  const recent = dxs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
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
    // Desk-compatible (simple average) and standard (Wilder's). They differ;
    // reporting both keeps the screen and the server honest with each other.
    rsi: rsi(closes, 14),
    rsiWilder: rsiWilder(closes, 14),
    adx: adx(highs, lows, closes, 14),
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

  let conv = Math.abs(score) >= 5 ? 'H' : Math.abs(score) >= 3 ? 'M' : 'L';

  // A weak trend is exactly when this kind of score is least worth acting on,
  // so ADX caps conviction rather than being reported and ignored.
  if (ind.adx != null && ind.adx < 20 && conv === 'H') {
    conv = 'M';
    reasons.push('ADX below 20 — trend too weak for high conviction');
  }

  const entry = ind.last;
  // A zone, not a point. Quoting an entry to the cent implies a precision the
  // model does not have; the band is roughly half an average day's range.
  const band = ind.atr ? ind.atr * 0.5 : ind.last * 0.01;
  const entryLow = entry - band;
  const entryHigh = entry + band;
  const stop = ind.atr ? ind.last - 2 * ind.atr : ind.last * 0.94;
  const target = ind.atr ? ind.last + 3 * ind.atr : ind.last * 1.12;
  const risk = ind.vol > 55 ? 8 : ind.vol > 40 ? 6 : ind.vol > 25 ? 4 : 3;

  return {
    label,
    cls,
    conv,
    score,
    reasons,
    entry,
    entryLow,
    entryHigh,
    stop,
    target,
    risk,
    // Falsifiable conditions in the goal grammar, so a thesis can be armed and
    // alerted on when it breaks rather than quietly going stale.
    assumptions: thesisAssumptions(ind, label),
  };
}

/**
 * The two or three things that would have to stop being true for the call to
 * be wrong, written as conditions the autonomy loop can evaluate.
 */
export function thesisAssumptions(ind, label, symbol = 'SYM') {
  const out = [];
  const round = (v) => Math.round(v * 100) / 100;

  if (ind.s50 != null) {
    out.push(
      label === 'SELL'
        ? `price(${symbol}) crosses above ${round(ind.s50)}`
        : `price(${symbol}) crosses below ${round(ind.s50)}`,
    );
  }
  if (ind.atr != null) {
    const stop = label === 'SELL' ? ind.last + 2 * ind.atr : ind.last - 2 * ind.atr;
    out.push(
      label === 'SELL'
        ? `price(${symbol}) crosses above ${round(stop)}`
        : `price(${symbol}) crosses below ${round(stop)}`,
    );
  }
  if (ind.rsi != null && label !== 'SELL') {
    out.push(`rsi(${symbol}) crosses above 75`);
  }
  return out.slice(0, 3);
}
