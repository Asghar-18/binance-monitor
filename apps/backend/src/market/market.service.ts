import { Injectable, Logger } from '@nestjs/common';
import { BinanceClient } from '../binance/binance.client';
import { Kline, Ticker24h, TickerPrice } from '../binance/binance.types';
import { STABLECOINS } from '../config';

export interface UsdPrice {
  price: number;
  route: string;
  /** Symbol whose 24h change represents this asset, if any */
  changeSymbol: string | null;
}

/**
 * Current and historical USD prices.
 * USD is approximated by USDT, as Binance has no direct USD spot market.
 */
@Injectable()
export class MarketService {
  private readonly log = new Logger(MarketService.name);
  private prices = new Map<string, number>();
  /** 24h change % per symbol, from the WebSocket feed or the REST fallback */
  private changes = new Map<string, number>();
  private historyCache = new Map<string, number | null>();

  constructor(private readonly binance: BinanceClient) {}

  hasSymbol(symbol: string): boolean {
    return this.prices.has(symbol);
  }

  lastRestRefresh = 0;

  async refreshPrices(): Promise<void> {
    const all = await this.binance.get<TickerPrice[]>('/api/v3/ticker/price');
    const next = new Map<string, number>();
    for (const t of all) next.set(t.symbol, Number(t.price));
    this.prices = next;
    this.lastRestRefresh = Date.now();
  }

  /** Called by the WebSocket feed for every mini-ticker update. */
  applyTicker(symbol: string, close: number, open24h: number): void {
    if (!Number.isFinite(close) || close <= 0) return;
    this.prices.set(symbol, close);
    if (open24h > 0) this.changes.set(symbol, ((close - open24h) / open24h) * 100);
  }

  changeFor(symbol: string | null): number | null {
    return symbol ? (this.changes.get(symbol) ?? null) : null;
  }

  /** REST fallback for 24h change when the live feed is down. */
  async refreshChanges(symbols: string[]): Promise<void> {
    const fresh = await this.change24h(symbols);
    for (const [s, v] of fresh) this.changes.set(s, v);
  }

  /** Current USD price of an asset, trying direct stable pairs first, then via BTC. */
  usdPrice(asset: string): UsdPrice | null {
    if (asset === 'USDT') return { price: 1, route: 'USDT', changeSymbol: null };
    if (STABLECOINS.has(asset)) {
      const p = this.prices.get(`${asset}USDT`);
      return { price: p ?? 1, route: p ? `${asset}USDT` : 'stablecoin', changeSymbol: null };
    }
    for (const q of ['USDT', 'FDUSD', 'USDC']) {
      const p = this.prices.get(`${asset}${q}`);
      if (p) return { price: p, route: `${asset}${q}`, changeSymbol: `${asset}${q}` };
    }
    const viaBtc = this.prices.get(`${asset}BTC`);
    const btc = this.prices.get('BTCUSDT');
    if (viaBtc && btc) return { price: viaBtc * btc, route: `${asset}BTC x BTCUSDT`, changeSymbol: `${asset}BTC` };
    return null;
  }

  async change24h(symbols: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (symbols.length === 0) return out;
    // Weight is 2 per symbol up to 20 symbols, so batch in groups of 20.
    for (let i = 0; i < symbols.length; i += 20) {
      const batch = symbols.slice(i, i + 20);
      const rows = await this.binance.get<Ticker24h[]>('/api/v3/ticker/24hr', {
        symbols: JSON.stringify(batch),
      });
      for (const r of rows) out.set(r.symbol, Number(r.priceChangePercent));
    }
    return out;
  }

  /**
   * USD price of an asset at a past moment, from the 1-minute candle.
   * Returns null when no route to USDT exists.
   */
  async usdPriceAt(asset: string, ms: number): Promise<number | null> {
    if (STABLECOINS.has(asset)) return 1;
    const direct = await this.closeAt(`${asset}USDT`, ms);
    if (direct !== null) return direct;
    const viaBtc = await this.closeAt(`${asset}BTC`, ms);
    const btc = viaBtc !== null ? await this.closeAt('BTCUSDT', ms) : null;
    if (viaBtc !== null && btc !== null) return viaBtc * btc;
    return null;
  }

  private async closeAt(symbol: string, ms: number): Promise<number | null> {
    const minute = Math.floor(ms / 60_000) * 60_000;
    const key = `${symbol}:${minute}`;
    if (this.historyCache.has(key)) return this.historyCache.get(key)!;
    let result: number | null = null;
    try {
      // Delisted symbols are absent from the live price list but may still have klines,
      // so try the request whenever the symbol is live or unknown.
      const rows = await this.binance.get<Kline[]>('/api/v3/klines', {
        symbol,
        interval: '1m',
        startTime: minute,
        limit: 1,
      });
      if (rows.length > 0) result = Number(rows[0][4]);
    } catch (e) {
      // -1121 = invalid symbol: expected for routes that do not exist
      const code = (e as { code?: number }).code;
      if (code !== -1121) this.log.warn(`Kline lookup failed for ${symbol}: ${(e as Error).message}`);
    }
    if (this.historyCache.size > 20_000) this.historyCache.clear();
    this.historyCache.set(key, result);
    return result;
  }
}
