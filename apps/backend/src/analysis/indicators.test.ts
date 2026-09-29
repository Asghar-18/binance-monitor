import { describe, expect, it } from 'vitest';
import { ATR, EMA, MACD, RSI } from 'technicalindicators';
import { atr, Candle, ema, levels, macd, rsi, summarize, trendOf } from './indicators';

// Deterministic random walk so the test is repeatable.
function candles(n: number, seed = 42): Candle[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  let price = 0.2;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const open = price;
    price = Math.max(0.01, price * (1 + (rnd() - 0.5) * 0.04));
    const high = Math.max(open, price) * (1 + rnd() * 0.01);
    const low = Math.min(open, price) * (1 - rnd() * 0.01);
    out.push({ openTime: i * 3_600_000, open, high, low, close: price, volume: 1000 + rnd() * 500 });
  }
  return out;
}

const data = candles(300);
const closes = data.map((c) => c.close);
const close = (a: number[], b: number[], digits = 8) => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
};

describe('indicators match the technicalindicators library', () => {
  it('EMA 20 / 50 / 200', () => {
    for (const period of [20, 50, 200]) close(ema(closes, period), EMA.calculate({ period, values: closes }));
  });

  it('RSI 14', () => {
    // The library rounds RSI to 2 decimals
    close(rsi(closes).map((v) => Math.round(v * 100) / 100), RSI.calculate({ period: 14, values: closes }), 6);
  });

  it('MACD 12/26/9 histogram', () => {
    const ref = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false })
      .filter((r) => r.histogram !== undefined)
      .map((r) => r.histogram!);
    close(macd(closes).histogram, ref);
  });

  it('ATR 14', () => {
    const ref = ATR.calculate({ period: 14, high: data.map((c) => c.high), low: data.map((c) => c.low), close: closes });
    // The library rounds ATR; compare at 6 decimals on prices around 0.2
    close(atr(data), ref, 6);
  });
});

describe('summary rules', () => {
  it('trend labels follow the documented rule', () => {
    expect(trendOf(1.1, 1.05, 1.0, 0.01)).toBe('bullish');
    expect(trendOf(0.9, 0.95, 1.0, -0.01)).toBe('bearish');
    expect(trendOf(1.1, 0.95, 1.0, 0.01)).toBe('neutral');
  });

  it('summarize produces all fields with enough history', () => {
    const s = summarize(data)!;
    expect(s.ema200).not.toBeNull();
    expect(s.rsi).toBeGreaterThan(0);
    expect(s.rsi).toBeLessThan(100);
    expect(s.volumeRatio).toBeGreaterThan(0);
    expect(['bullish', 'bearish', 'neutral']).toContain(s.trend);
  });

  it('support is below and resistance above the price', () => {
    const price = closes[closes.length - 1];
    const { support, resistance } = levels([data.slice(-100)], price);
    if (support !== null) expect(support).toBeLessThan(price);
    if (resistance !== null) expect(resistance).toBeGreaterThan(price);
  });

  it('finds an obvious swing low and high', () => {
    const mk = (lows: number[], highs: number[]): Candle[] =>
      lows.map((l, i) => ({ openTime: i, open: 0, high: highs[i], low: l, close: 0, volume: 1 }));
    const c = mk([5, 4, 2, 4, 5, 6, 7], [6, 6, 6, 7, 9, 7, 7]);
    expect(levels([c], 3)).toEqual({ support: 2, resistance: 9 });
  });
});

describe('levels follow the live price', () => {
  it('re-picks support and resistance when price moves', async () => {
    const { swingLevels, nearestLevels } = await import('./indicators');
    const sw = { lows: [1, 2, 3], highs: [4, 5, 6] };
    expect(nearestLevels(sw, 3.5)).toEqual({ support: 3, resistance: 4 });
    expect(nearestLevels(sw, 2.5)).toEqual({ support: 2, resistance: 4 });
    expect(nearestLevels(sw, 0.5)).toEqual({ support: null, resistance: 4 });
    expect(swingLevels([]).lows).toEqual([]);
  });
});
