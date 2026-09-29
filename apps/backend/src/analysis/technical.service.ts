import { Injectable, Logger } from '@nestjs/common';
import type { Technical, Timeframe } from '@bpm/shared';
import { BinanceClient } from '../binance/binance.client';
import { Kline } from '../binance/binance.types';
import { MarketService } from '../market/market.service';
import { Candle, nearestLevels, summarize, swingLevels, TimeframeSummary } from './indicators';

const TIMEFRAMES: Timeframe[] = ['1h', '4h', '1d'];
/** How long fetched candles are reused before refetching */
const TTL_MS: Record<Timeframe, number> = { '1h': 2 * 60_000, '4h': 5 * 60_000, '1d': 15 * 60_000 };
const COMPUTE_TTL_MS = 2 * 60_000;

export interface TechnicalDetail extends Technical {
  summaries: Partial<Record<Timeframe, TimeframeSummary>>;
}

interface Stored extends TechnicalDetail {
  swings: { lows: number[]; highs: number[] };
}

/**
 * Fetches candles over REST (cached per timeframe) and computes indicators.
 * Only closed candles are used; the still-forming candle is dropped.
 */
@Injectable()
export class TechnicalService {
  private readonly log = new Logger(TechnicalService.name);
  private candleCache = new Map<string, { candles: Candle[]; at: number }>();
  private results = new Map<string, Stored>();
  private inFlight = new Map<string, Promise<Stored | null>>();

  constructor(
    private readonly binance: BinanceClient,
    private readonly market: MarketService,
  ) {}

  /** Pair to analyse for an asset: only direct stablecoin pairs, so levels are in USD. */
  symbolFor(asset: string): string | null {
    const s = this.market.usdPrice(asset)?.changeSymbol ?? null;
    return s && /(USDT|FDUSD|USDC)$/.test(s) ? s : null;
  }

  /** Last computed result without waiting; starts a refresh in the background when stale. */
  cached(asset: string): TechnicalDetail | null {
    const symbol = this.symbolFor(asset);
    if (!symbol) return null;
    const r = this.results.get(symbol) ?? null;
    if (!r || Date.now() - Date.parse(r.computedAt) > COMPUTE_TTL_MS) void this.compute(asset).catch(() => undefined);
    return r ? this.withLiveLevels(r, asset) : null;
  }

  /** Fresh (or at most 2 minutes old) indicators for an asset. */
  async compute(asset: string): Promise<TechnicalDetail | null> {
    const symbol = this.symbolFor(asset);
    if (!symbol) return null;
    const recent = this.results.get(symbol);
    if (recent && Date.now() - Date.parse(recent.computedAt) < COMPUTE_TTL_MS) return this.withLiveLevels(recent, asset);
    let job = this.inFlight.get(symbol);
    if (!job) {
      job = this.doCompute(symbol).finally(() => this.inFlight.delete(symbol));
      this.inFlight.set(symbol, job);
    }
    const r = await job;
    return r ? this.withLiveLevels(r, asset) : null;
  }

  /** Support/resistance picked against the live price, so a fast move never leaves support above price. */
  private withLiveLevels(r: Stored, asset: string): TechnicalDetail {
    const price = this.market.usdPrice(asset)?.price ?? r.summaries['1h']?.close ?? 0;
    const lv = nearestLevels(r.swings, price);
    const { swings: _swings, ...rest } = r;
    return { ...rest, supportUsd: lv.support, resistanceUsd: lv.resistance };
  }

  private async doCompute(symbol: string): Promise<Stored | null> {
    try {
      const series = await Promise.all(TIMEFRAMES.map((tf) => this.candles(symbol, tf)));
      const summaries: Partial<Record<Timeframe, TimeframeSummary>> = {};
      TIMEFRAMES.forEach((tf, i) => {
        const s = summarize(series[i]);
        if (s) summaries[tf] = s;
      });
      const swings = swingLevels([series[1].slice(-120), series[2].slice(-120)]);

      const result: Stored = {
        symbol,
        timeframes: Object.fromEntries(
          Object.entries(summaries).map(([tf, s]) => [tf, { trend: s!.trend, rsi: s!.rsi, volumeRatio: s!.volumeRatio, atrPct: s!.atrPct }]),
        ),
        ema50_4h: summaries['4h']?.ema50 ?? null,
        ema200_1d: summaries['1d']?.ema200 ?? null,
        supportUsd: null,
        resistanceUsd: null,
        computedAt: new Date().toISOString(),
        summaries,
        swings,
      };
      this.results.set(symbol, result);
      return result;
    } catch (e) {
      this.log.warn(`Indicators for ${symbol} failed: ${(e as Error).message}`);
      return this.results.get(symbol) ?? null;
    }
  }

  private async candles(symbol: string, tf: Timeframe): Promise<Candle[]> {
    const key = `${symbol}:${tf}`;
    const hit = this.candleCache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS[tf]) return hit.candles;

    const rows = await this.binance.get<Kline[]>('/api/v3/klines', { symbol, interval: tf, limit: 250 });
    const now = Date.now();
    const candles = rows
      .filter((k) => k[6] < now) // closed candles only
      .map((k) => ({ openTime: k[0], open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
    this.candleCache.set(key, { candles, at: now });
    return candles;
  }
}
