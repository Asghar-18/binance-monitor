import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, Db } from '../db/tokens';
import { fxRates } from '../db/schema';

/** First date the free currency API publishes history for. Earlier trades use this rate. */
const EARLIEST_DATE = '2024-03-02';
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

const urls = (date: string) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.min.json`,
  `https://${date}.currency-api.pages.dev/v1/currencies/usd.min.json`,
];

export const toDateKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * USD/PKR rates from the free fawazahmed0 currency API (jsDelivr, Cloudflare fallback).
 * Historical rates are cached in Postgres forever; the latest rate is refreshed every few hours.
 */
@Injectable()
export class FxService {
  private readonly log = new Logger(FxService.name);
  private latest: { rate: number; date: string; fetchedAt: number } | null = null;
  private memo = new Map<string, number>();

  constructor(@Inject(DB) private readonly db: Db) {}

  current(): { usdPkr: number | null; date: string | null; stale: boolean } {
    if (!this.latest) return { usdPkr: null, date: null, stale: true };
    const age = Date.now() - Date.parse(`${this.latest.date}T00:00:00Z`);
    return { usdPkr: this.latest.rate, date: this.latest.date, stale: age > STALE_AFTER_MS };
  }

  async refreshLatest(): Promise<void> {
    try {
      const { rate, date } = await this.fetchRate('latest');
      this.latest = { rate, date, fetchedAt: Date.now() };
      await this.store(date, rate);
    } catch (e) {
      this.log.warn(`Could not refresh USD/PKR rate: ${(e as Error).message}`);
      if (!this.latest) {
        // Fall back to the newest stored rate so the dashboard still shows PKR.
        const rows = await this.db.select().from(fxRates);
        const newest = rows.sort((a, b) => b.date.localeCompare(a.date))[0];
        if (newest) this.latest = { rate: newest.usdPkr, date: newest.date, fetchedAt: Date.now() };
      }
    }
  }

  /** USD/PKR for a trade timestamp. Returns null only if no rate can be found at all. */
  async rateOn(ms: number): Promise<number | null> {
    let date = toDateKey(ms);
    if (date < EARLIEST_DATE) date = EARLIEST_DATE;
    const today = toDateKey(Date.now());
    if (date >= today) return this.latest?.rate ?? null;

    const cached = this.memo.get(date);
    if (cached) return cached;
    const [row] = await this.db.select().from(fxRates).where(eq(fxRates.date, date));
    if (row) {
      this.memo.set(date, row.usdPkr);
      return row.usdPkr;
    }
    try {
      const { rate } = await this.fetchRate(date);
      await this.store(date, rate);
      this.memo.set(date, rate);
      return rate;
    } catch (e) {
      this.log.warn(`No USD/PKR rate for ${date}: ${(e as Error).message}`);
      return this.latest?.rate ?? null;
    }
  }

  private async store(date: string, rate: number) {
    await this.db
      .insert(fxRates)
      .values({ date, usdPkr: rate })
      .onConflictDoUpdate({ target: fxRates.date, set: { usdPkr: rate } });
  }

  private async fetchRate(date: string): Promise<{ rate: number; date: string }> {
    let lastError: unknown;
    for (const url of urls(date)) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { date: string; usd: Record<string, number> };
        const rate = body.usd?.pkr;
        if (!rate || !Number.isFinite(rate)) throw new Error('PKR missing in response');
        return { rate, date: body.date };
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
