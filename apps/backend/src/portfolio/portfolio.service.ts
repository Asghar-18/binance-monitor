import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { eq } from 'drizzle-orm';
import type { Currency, PortfolioSnapshot, Position } from '@bpm/shared';
import { BinanceClient } from '../binance/binance.client';
import { AccountInfo, ApiRestrictions } from '../binance/binance.types';
import { AppConfig, CONFIG, STABLECOINS } from '../config';
import { DB, Db } from '../db/tokens';
import { entryOverrides, trades } from '../db/schema';
import { FxService } from '../fx/fx.service';
import { MarketService } from '../market/market.service';
import { PriceStreamService } from '../market/price-stream.service';
import { TradeSyncService } from '../sync/trade-sync.service';
import { Basis, buildFills, computeBasis, resolveEntry } from './cost-basis';

const isStable = (a: string) => STABLECOINS.has(a);
const pct = (part: number, whole: number) => (whole !== 0 ? (part / whole) * 100 : null);

/** Snapshot without the alert fields, which AlertService adds. */
export type BaseSnapshot = Omit<PortfolioSnapshot, 'alerts' | 'status'> & {
  status: Omit<PortfolioSnapshot['status'], 'telegram' | 'ntfy' | 'ai' | 'digest'>;
};

@Injectable()
export class PortfolioService implements OnApplicationBootstrap {
  private readonly log = new Logger(PortfolioService.name);
  private balances = new Map<string, number>();
  private basisByAsset = new Map<string, Basis>();
  private overrides = new Map<string, { avgUsd: number; avgPkr: number }>();
  private keyReadOnly: boolean | null = null;
  private keyWarnings: string[] = [];
  private lastBalanceSync: Date | null = null;
  private balanceError: string | null = null;
  private knownAssets = new Set<string>();
  private ready = false;
  private readonly entryListeners: ((asset: string) => void)[] = [];

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(DB) private readonly db: Db,
    private readonly binance: BinanceClient,
    private readonly market: MarketService,
    private readonly stream: PriceStreamService,
    private readonly fx: FxService,
    private readonly tradeSync: TradeSyncService,
  ) {}

  async onApplicationBootstrap() {
    await this.checkKeyPermissions();
    await this.fx.refreshLatest();
    await this.loadOverrides();
    await this.recomputeBasis();
    await this.refresh();
    this.ready = true;
    // First import can take minutes; run it in the background.
    void this.runTradeSync();
  }

  /** Called with an asset whenever its entry price changes (manual override or new trades). */
  onEntryChanged(fn: (asset: string) => void) {
    this.entryListeners.push(fn);
  }

  /** True when prices are recent enough to act on. */
  pricesFresh(): boolean {
    return this.stream.isLive() || Date.now() - this.market.lastRestRefresh < 150_000;
  }

  /** FR-1.1: refuse to run with a key that can trade, transfer or withdraw. */
  private async checkKeyPermissions() {
    const r = await this.binance.signedGet<ApiRestrictions>('/sapi/v1/account/apiRestrictions');
    const dangerous = (
      [
        ['enableSpotAndMarginTrading', 'spot and margin trading'],
        ['enableWithdrawals', 'withdrawals'],
        ['enableInternalTransfer', 'internal transfer'],
        ['enableMargin', 'margin'],
        ['enableFutures', 'futures'],
        ['enableVanillaOptions', 'options'],
        ['permitsUniversalTransfer', 'universal transfer'],
        ['enablePortfolioMarginTrading', 'portfolio margin'],
        ['enableFixApiTrade', 'FIX API trading'],
      ] as const
    )
      .filter(([k]) => r[k] === true)
      .map(([, label]) => label);

    this.keyWarnings = [];
    if (!r.ipRestrict) this.keyWarnings.push('API key has no IP whitelist. Restrict it to your server IP in Binance.');
    if (dangerous.length > 0) {
      const msg = `API key has extra permissions: ${dangerous.join(', ')}. Create a key with only "Enable Reading".`;
      if (!this.cfg.ALLOW_UNSAFE_KEY) throw new Error(msg);
      this.keyWarnings.push(msg);
    }
    this.keyReadOnly = dangerous.length === 0;
    this.log.log(`API key check passed (read-only: ${this.keyReadOnly}, IP restricted: ${r.ipRestrict})`);
  }

  /** Balances and REST prices every minute; live prices arrive over WebSocket in between. */
  @Interval(60_000)
  async refresh(): Promise<void> {
    try {
      const [account] = await Promise.all([
        this.binance.signedGet<AccountInfo>('/api/v3/account', { omitZeroBalances: true }),
        this.market.refreshPrices(),
      ]);
      const next = new Map<string, number>();
      for (const b of account.balances) {
        // LD* assets are Simple Earn wrappers; V1 covers the Spot wallet only.
        if (b.asset.startsWith('LD')) continue;
        const qty = Number(b.free) + Number(b.locked);
        if (qty > 0) next.set(b.asset, qty);
      }
      this.balances = next;
      this.lastBalanceSync = new Date();
      this.balanceError = null;

      const newAsset = [...next.keys()].some((a) => !this.knownAssets.has(a));
      this.knownAssets = new Set(next.keys());
      if (newAsset && this.ready) void this.runTradeSync();
    } catch (e) {
      this.balanceError = (e as Error).message;
      this.log.warn(`Balance refresh failed: ${this.balanceError}`);
    }

    const symbols = this.routeSymbols();
    this.stream.setSymbols(symbols);
    if (!this.stream.isLive()) {
      await this.market.refreshChanges(symbols).catch((e) => this.log.warn(`24h change lookup failed: ${(e as Error).message}`));
    }
  }

  @Interval(15 * 60_000)
  async runTradeSync(): Promise<void> {
    const changed = await this.tradeSync.sync([...this.balances.keys()]);
    if (changed) {
      await this.recomputeBasis();
      for (const asset of this.balances.keys()) this.emitEntryChanged(asset);
    }
  }

  @Interval(6 * 60 * 60_000)
  async refreshFx(): Promise<void> {
    await this.fx.refreshLatest();
  }

  async setOverride(asset: string, price: number, currency: Currency): Promise<void> {
    const rate = this.fx.current().usdPkr;
    if (!rate) throw new Error('USD/PKR rate unavailable; try again shortly');
    const avgUsd = currency === 'USD' ? price : price / rate;
    const avgPkr = currency === 'PKR' ? price : price * rate;
    await this.db
      .insert(entryOverrides)
      .values({ asset, avgUsd, avgPkr, inputCurrency: currency })
      .onConflictDoUpdate({ target: entryOverrides.asset, set: { avgUsd, avgPkr, inputCurrency: currency, updatedAt: new Date() } });
    await this.loadOverrides();
    this.emitEntryChanged(asset);
  }

  async clearOverride(asset: string): Promise<void> {
    await this.db.delete(entryOverrides).where(eq(entryOverrides.asset, asset));
    await this.loadOverrides();
    this.emitEntryChanged(asset);
  }

  private emitEntryChanged(asset: string) {
    for (const fn of this.entryListeners) {
      try {
        fn(asset);
      } catch (e) {
        this.log.warn(`Entry listener failed: ${(e as Error).message}`);
      }
    }
  }

  private async loadOverrides() {
    const rows = await this.db.select().from(entryOverrides);
    this.overrides = new Map(rows.map((r) => [r.asset, { avgUsd: r.avgUsd, avgPkr: r.avgPkr }]));
  }

  private async recomputeBasis() {
    const rows = await this.db.select().from(trades);
    const fills = buildFills(rows, isStable);
    const byAsset = new Map<string, typeof fills>();
    for (const f of fills) {
      const list = byAsset.get(f.asset) ?? [];
      list.push(f);
      byAsset.set(f.asset, list);
    }
    this.basisByAsset = new Map([...byAsset].map(([asset, list]) => [asset, computeBasis(list)]));
  }

  /** Symbols whose prices matter for current holdings. */
  private routeSymbols(): string[] {
    const out = new Set<string>();
    for (const asset of this.balances.keys()) {
      const p = this.market.usdPrice(asset);
      if (p?.changeSymbol) out.add(p.changeSymbol);
      if (p?.route.includes('BTCUSDT')) out.add('BTCUSDT');
    }
    return [...out];
  }

  /** Builds a snapshot from the latest in-memory prices. Cheap; called on every request. */
  getSnapshot(): BaseSnapshot | null {
    if (!this.ready) return null;
    const fx = this.fx.current();
    const rate = fx.usdPkr;
    const toPkr = (usd: number | null) => (usd !== null && rate !== null ? usd * rate : null);

    const raw = [...this.balances].map(([asset, quantity]) => {
      const price = this.market.usdPrice(asset);
      return { asset, quantity, price, valueUsd: price ? price.price * quantity : null };
    });
    const visible = raw.filter((r) => r.valueUsd === null || r.valueUsd >= this.cfg.DUST_USD);

    const totalUsd = visible.reduce((s, r) => s + (r.valueUsd ?? 0), 0);
    let pnlUsd = 0;
    let costUsd = 0;
    let pnlPkr = 0;
    let costPkr = 0;
    let anyPnl = false;
    let pkrComplete = true;
    let stableUsd = 0;

    const positions: Position[] = visible.map((r) => {
      const stable = isStable(r.asset);
      if (stable) stableUsd += r.valueUsd ?? 0;
      const entry = stable
        ? { source: 'unknown' as const, avgUsd: null, avgPkr: null, coveragePct: null }
        : resolveEntry(r.quantity, this.basisByAsset.get(r.asset), this.overrides.get(r.asset));
      const valuePkr = toPkr(r.valueUsd);

      let pUsd: number | null = null;
      let pPkr: number | null = null;
      if (r.valueUsd !== null && entry.avgUsd !== null) {
        const cost = entry.avgUsd * r.quantity;
        pUsd = r.valueUsd - cost;
        pnlUsd += pUsd;
        costUsd += cost;
        anyPnl = true;
        if (valuePkr !== null && entry.avgPkr !== null) {
          const cPkr = entry.avgPkr * r.quantity;
          pPkr = valuePkr - cPkr;
          pnlPkr += pPkr;
          costPkr += cPkr;
        } else pkrComplete = false;
      }

      return {
        asset: r.asset,
        quantity: r.quantity,
        isStable: stable,
        priceUsd: r.price?.price ?? null,
        priceRoute: r.price?.route ?? null,
        change24hPct: this.market.changeFor(r.price?.changeSymbol ?? null),
        valueUsd: r.valueUsd,
        valuePkr,
        sharePct: r.valueUsd !== null ? pct(r.valueUsd, totalUsd) : null,
        entry,
        pnl: {
          usd: pUsd,
          usdPct: pUsd !== null && entry.avgUsd ? pct(pUsd, entry.avgUsd * r.quantity) : null,
          pkr: pPkr,
          pkrPct: pPkr !== null && entry.avgPkr ? pct(pPkr, entry.avgPkr * r.quantity) : null,
        },
      };
    });

    positions.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

    const errors: string[] = [];
    if (this.balanceError) errors.push(`Balances: ${this.balanceError}`);
    errors.push(...this.tradeSync.lastErrors.slice(0, 5));

    const lastPrice = Math.max(this.stream.lastMessageAt, this.market.lastRestRefresh);
    return {
      updatedAt: new Date().toISOString(),
      totals: {
        valueUsd: totalUsd,
        valuePkr: toPkr(totalUsd),
        pnlUsd: anyPnl ? pnlUsd : null,
        pnlUsdPct: anyPnl ? pct(pnlUsd, costUsd) : null,
        pnlPkr: anyPnl && pkrComplete && rate !== null ? pnlPkr : null,
        pnlPkrPct: anyPnl && pkrComplete && rate !== null ? pct(pnlPkr, costPkr) : null,
        stableSharePct: pct(stableUsd, totalUsd) ?? 0,
      },
      positions,
      hiddenDustCount: raw.length - visible.length,
      dustThresholdUsd: this.cfg.DUST_USD,
      fx,
      status: {
        keyReadOnly: this.keyReadOnly,
        keyWarnings: this.keyWarnings,
        lastBalanceSync: this.lastBalanceSync?.toISOString() ?? null,
        lastTradeSync: this.tradeSync.lastRun?.toISOString() ?? null,
        tradeSyncRunning: this.tradeSync.running,
        liveFeed: this.stream.isLive(),
        lastPriceAt: lastPrice > 0 ? new Date(lastPrice).toISOString() : null,
        errors,
      },
    };
  }
}
