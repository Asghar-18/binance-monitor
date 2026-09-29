import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { BinanceClient } from '../binance/binance.client';
import { ConvertTradeFlow, MyTrade } from '../binance/binance.types';
import { AppConfig, CONFIG, STABLECOINS } from '../config';
import { DB, Db } from '../db/tokens';
import { NewTradeRow, syncState, trades } from '../db/schema';
import { FxService } from '../fx/fx.service';
import { MarketService } from '../market/market.service';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Imports Spot trades and Convert orders into Postgres, incrementally.
 * Spot trades are fetched per symbol (Binance has no "all my trades" endpoint),
 * for every held asset against every configured quote asset.
 */
@Injectable()
export class TradeSyncService {
  private readonly log = new Logger(TradeSyncService.name);
  running = false;
  lastRun: Date | null = null;
  lastErrors: string[] = [];

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(DB) private readonly db: Db,
    private readonly binance: BinanceClient,
    private readonly market: MarketService,
    private readonly fx: FxService,
  ) {}

  /** Returns true if any new rows were imported. */
  async sync(heldAssets: string[]): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    const errors: string[] = [];
    let imported = 0;
    try {
      const symbols = this.symbolsToSync(heldAssets);
      for (const s of symbols) {
        try {
          imported += await this.syncSymbol(s.symbol, s.base, s.quote);
        } catch (e) {
          errors.push(`${s.symbol}: ${(e as Error).message}`);
        }
      }
      try {
        imported += await this.syncConvert();
      } catch (e) {
        errors.push(`Convert history: ${(e as Error).message}`);
      }
      if (imported > 0) this.log.log(`Imported ${imported} new trades`);
      return imported > 0;
    } finally {
      this.lastErrors = errors;
      for (const e of errors) this.log.warn(e);
      this.lastRun = new Date();
      this.running = false;
    }
  }

  private symbolsToSync(held: string[]) {
    const out: { symbol: string; base: string; quote: string }[] = [];
    for (const base of held) {
      if (STABLECOINS.has(base)) continue;
      for (const quote of this.cfg.QUOTE_ASSETS) {
        if (quote === base) continue;
        const symbol = `${base}${quote}`;
        if (this.market.hasSymbol(symbol)) out.push({ symbol, base, quote });
      }
    }
    return out;
  }

  private async syncSymbol(symbol: string, base: string, quote: string): Promise<number> {
    const key = `spot:${symbol}`;
    let fromId = Number((await this.getState(key)) ?? '-1') + 1;
    let imported = 0;

    for (;;) {
      const batch = await this.binance.signedGet<MyTrade[]>('/api/v3/myTrades', { symbol, fromId, limit: 1000 });
      if (batch.length === 0) break;

      const rows: NewTradeRow[] = [];
      for (const t of batch) {
        const quoteQty = Number(t.quoteQty);
        const commission = Number(t.commission);
        const quoteUsdPrice = await this.market.usdPriceAt(quote, t.time);
        let feeUsd = 0;
        if (commission > 0 && t.commissionAsset !== base) {
          const feePrice = await this.market.usdPriceAt(t.commissionAsset, t.time);
          feeUsd = feePrice !== null ? commission * feePrice : 0;
        }
        rows.push({
          source: 'spot',
          externalId: String(t.id),
          symbol,
          baseAsset: base,
          quoteAsset: quote,
          isBuy: t.isBuyer,
          qty: Number(t.qty),
          quoteQty,
          price: Number(t.price),
          commission,
          commissionAsset: t.commissionAsset,
          time: t.time,
          quoteUsd: quoteUsdPrice !== null ? quoteQty * quoteUsdPrice : null,
          feeUsd,
          usdPkr: await this.fx.rateOn(t.time),
        });
      }
      await this.db.insert(trades).values(rows).onConflictDoNothing();
      imported += rows.length;

      const lastId = batch[batch.length - 1].id;
      await this.setState(key, String(lastId));
      if (batch.length < 1000) break;
      fromId = lastId + 1;
    }
    return imported;
  }

  /** Convert history is queried in windows of at most 30 days. */
  private async syncConvert(): Promise<number> {
    const key = 'convert:lastEnd';
    const saved = await this.getState(key);
    const now = Date.now();
    let start = saved ? Number(saved) - DAY : now - this.cfg.CONVERT_LOOKBACK_DAYS * DAY;
    let imported = 0;

    while (start < now) {
      const end = Math.min(start + 30 * DAY - 1, now);
      const flow = await this.binance.signedGet<ConvertTradeFlow>('/sapi/v1/convert/tradeFlow', {
        startTime: start,
        endTime: end,
        limit: 1000,
      });
      if (flow.moreData) this.log.warn('Convert window has more than 1000 orders; some may be missing');

      const rows: NewTradeRow[] = [];
      for (const c of flow.list ?? []) {
        if (c.orderStatus !== 'SUCCESS') continue;
        const fromAmount = Number(c.fromAmount);
        const toAmount = Number(c.toAmount);
        // Prefer the stable side for an exact USD value.
        let usd: number | null;
        if (STABLECOINS.has(c.fromAsset)) usd = fromAmount;
        else if (STABLECOINS.has(c.toAsset)) usd = toAmount;
        else {
          const p = await this.market.usdPriceAt(c.fromAsset, c.createTime);
          usd = p !== null ? fromAmount * p : null;
        }
        rows.push({
          source: 'convert',
          externalId: String(c.orderId),
          symbol: `${c.fromAsset}>${c.toAsset}`,
          baseAsset: c.toAsset,
          quoteAsset: c.fromAsset,
          isBuy: true,
          qty: toAmount,
          quoteQty: fromAmount,
          price: toAmount > 0 ? fromAmount / toAmount : 0,
          commission: 0,
          commissionAsset: null,
          time: c.createTime,
          quoteUsd: usd,
          feeUsd: 0,
          usdPkr: await this.fx.rateOn(c.createTime),
        });
      }
      if (rows.length > 0) {
        await this.db.insert(trades).values(rows).onConflictDoNothing();
        imported += rows.length;
      }
      await this.setState(key, String(end));
      start = end + 1;
    }
    return imported;
  }

  private async getState(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(syncState).where(eq(syncState.key, key));
    return row?.value ?? null;
  }

  private async setState(key: string, value: string) {
    await this.db
      .insert(syncState)
      .values({ key, value })
      .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt: new Date() } });
  }
}
