/**
 * Pure technical indicators on closed candles. No I/O; verified in tests
 * against the independent `technicalindicators` library.
 */

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** EMA seeded with the SMA of the first `period` values (standard convention). */
export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes: number[], period = 14): number[] {
  if (closes.length <= period) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const value = () => (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  const out = [value()];
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out.push(value());
  }
  return out;
}

/** MACD 12/26/9: returns aligned macd, signal and histogram series (latest last). */
export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const offset = slow - fast;
  const line = s.map((v, i) => f[i + offset] - v);
  const sig = ema(line, signal);
  const hist = sig.map((v, i) => line[i + (signal - 1)] - v);
  return { macd: line.slice(signal - 1), signal: sig, histogram: hist };
}

/** Wilder's ATR. */
export function atr(candles: Candle[], period = 14): number[] {
  if (candles.length <= period) return [];
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  let prev = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const out = [prev];
  for (let i = period; i < tr.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out.push(prev);
  }
  return out;
}

export type Trend = 'bullish' | 'bearish' | 'neutral';

export interface TimeframeSummary {
  close: number;
  rsi: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  macdHistogram: number | null;
  atrPct: number | null;
  /** Last closed candle volume / average of the previous 20 */
  volumeRatio: number | null;
  trend: Trend | null;
}

const last = <T>(a: T[]): T | null => (a.length ? a[a.length - 1] : null);

/**
 * Trend rule (FR requirements doc):
 * bullish = close > EMA50 and EMA20 > EMA50 and MACD histogram > 0
 * bearish = close < EMA50 and EMA20 < EMA50 and MACD histogram < 0
 * neutral otherwise
 */
export function trendOf(close: number, e20: number | null, e50: number | null, hist: number | null): Trend | null {
  if (e20 === null || e50 === null || hist === null) return null;
  if (close > e50 && e20 > e50 && hist > 0) return 'bullish';
  if (close < e50 && e20 < e50 && hist < 0) return 'bearish';
  return 'neutral';
}

export function summarize(candles: Candle[]): TimeframeSummary | null {
  if (candles.length < 30) return null;
  const closes = candles.map((c) => c.close);
  const close = closes[closes.length - 1];
  const e20 = last(ema(closes, 20));
  const e50 = last(ema(closes, 50));
  const e200 = last(ema(closes, 200));
  const hist = last(macd(closes).histogram);
  const a = last(atr(candles));
  const vols = candles.map((c) => c.volume);
  const prev = vols.slice(-21, -1);
  const avgVol = prev.length === 20 ? prev.reduce((s, v) => s + v, 0) / 20 : null;
  return {
    close,
    rsi: last(rsi(closes)),
    ema20: e20,
    ema50: e50,
    ema200: e200,
    macdHistogram: hist,
    atrPct: a !== null ? (a / close) * 100 : null,
    volumeRatio: avgVol ? vols[vols.length - 1] / avgVol : null,
    trend: trendOf(close, e20, e50, hist),
  };
}

/**
 * Swing points: a bar whose low (high) is the lowest (highest) of `wing` bars on each side.
 * Levels within `mergePct` % are merged. Returns all levels so the nearest ones can be picked
 * against the live price at the moment they are shown.
 */
export function swingLevels(series: Candle[][], wing = 2, mergePct = 0.5): { lows: number[]; highs: number[] } {
  const lows: number[] = [];
  const highs: number[] = [];
  for (const candles of series) {
    for (let i = wing; i < candles.length - wing; i++) {
      const win = candles.slice(i - wing, i + wing + 1);
      if (win.every((c) => c.low >= candles[i].low)) lows.push(candles[i].low);
      if (win.every((c) => c.high <= candles[i].high)) highs.push(candles[i].high);
    }
  }
  const merge = (xs: number[]) => {
    const sorted = [...xs].sort((a, b) => a - b);
    const out: number[] = [];
    for (const x of sorted) {
      const prev = out[out.length - 1];
      if (prev !== undefined && ((x - prev) / prev) * 100 <= mergePct) out[out.length - 1] = (prev + x) / 2;
      else out.push(x);
    }
    return out;
  };
  return { lows: merge(lows), highs: merge(highs) };
}

/** Nearest support below and resistance above the given price. */
export function nearestLevels(sw: { lows: number[]; highs: number[] }, price: number): { support: number | null; resistance: number | null } {
  return {
    support: sw.lows.filter((l) => l < price).pop() ?? null,
    resistance: sw.highs.find((h) => h > price) ?? null,
  };
}

export function levels(series: Candle[][], price: number, wing = 2, mergePct = 0.5) {
  return nearestLevels(swingLevels(series, wing, mergePct), price);
}
