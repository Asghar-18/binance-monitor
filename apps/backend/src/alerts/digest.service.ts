import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, gte, eq } from 'drizzle-orm';
import type { Currency } from '@bpm/shared';
import { AnalysisService } from '../analysis/analysis.service';
import { digestInput } from '../analysis/inputs';
import { AppConfig, CONFIG } from '../config';
import { DB, Db } from '../db/tokens';
import { KvService } from '../db/kv.service';
import { alerts } from '../db/schema';
import { PortfolioService } from '../portfolio/portfolio.service';
import { money, pct } from './format';
import { NotifierService } from './notifier.service';

/** Sends one portfolio summary per day at DIGEST_TIME (local time in TIMEZONE). */
@Injectable()
export class DigestService {
  private readonly log = new Logger('Digest');
  private sending = false;

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(DB) private readonly db: Db,
    private readonly kv: KvService,
    private readonly portfolio: PortfolioService,
    private readonly notifier: NotifierService,
    private readonly analysis: AnalysisService,
  ) {}

  private localParts(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.cfg.TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
  }

  /** Checks every 30 s; sends once per local day, at or after DIGEST_TIME (catches up after a restart). */
  @Interval(30_000)
  async tick() {
    if (this.cfg.DIGEST_TIME === 'off' || this.sending) return;
    const { date, time } = this.localParts();
    if (time < this.cfg.DIGEST_TIME) return;
    if ((await this.kv.get('digest:lastDate')) === date) return;
    if (!this.portfolio.pricesFresh() || !this.notifier.anyChannel) return;
    await this.kv.set('digest:lastDate', date); // mark first so a failure never sends twice
    await this.send();
  }

  /** Builds and sends the summary now. Returns false if there was nothing to send or no channel accepted it. */
  async send(): Promise<boolean> {
    if (this.sending) return false;
    this.sending = true;
    try {
      const snap = this.portfolio.getSnapshot();
      if (!snap || snap.positions.length === 0) return false;
      const cur: Currency = snap.fx.usdPkr ? 'PKR' : 'USD';
      const value = (usd: number | null, pkr: number | null) => (cur === 'PKR' ? pkr : usd);

      // Portfolio 24h change from each coin's 24h move.
      let change = 0;
      let before = 0;
      for (const p of snap.positions) {
        const v = value(p.valueUsd, p.valuePkr) ?? 0;
        const prev = p.change24hPct !== null ? v / (1 + p.change24hPct / 100) : v;
        change += v - prev;
        before += prev;
      }
      const total = value(snap.totals.valueUsd, snap.totals.valuePkr);
      const changePct = before > 0 ? (change / before) * 100 : null;
      const pnl = value(snap.totals.pnlUsd, snap.totals.pnlPkr);
      const pnlPct = value(snap.totals.pnlUsdPct, snap.totals.pnlPkrPct);

      const since = new Date(Date.now() - 24 * 3_600_000);
      const recent = await this.db
        .select({ id: alerts.id })
        .from(alerts)
        .where(and(gte(alerts.createdAt, since), eq(alerts.status, 'sent')));

      const withTech = await Promise.all(
        snap.positions.map(async (p) => ({ p, tech: p.isStable ? null : await this.analysis.technical.compute(p.asset) })),
      );

      const lines: string[] = [];
      if (changePct !== null) lines.push(`Last 24h: ${pct(changePct)} (${money(change, cur, true)})`);
      if (pnl !== null) lines.push(`P/L from your entries: ${money(pnl, cur, true)} (${pct(pnlPct)})`);
      lines.push('');
      for (const { p, tech } of withTech) {
        const pp = cur === 'PKR' ? p.pnl.pkrPct : p.pnl.usdPct;
        const parts = [`${p.asset} ${money(value(p.valueUsd, p.valuePkr), cur)}`, `24h ${pct(p.change24hPct)}`];
        if (!p.isStable && pp !== null) parts.push(`P/L ${pct(pp)}`);
        const trend = tech?.timeframes['1d']?.trend;
        if (trend) parts.push(`daily trend ${trend}`);
        lines.push(parts.join(', '));
      }
      lines.push(`Alerts in the last 24h: ${recent.length}`);

      const input = digestInput(withTech, { value: total, change24h: change, change24hPct: changePct, pnl, pnlPct }, cur, recent.length);
      const ai = await this.analysis.claude.analyse('digest', null, input);
      if (ai) lines.push('', ai.summary, ...(ai.context ? [ai.context] : []));

      const result = await this.notifier.send({ severity: 'info', title: `Morning summary: ${money(total, cur)}`, lines });
      if (result.delivered) await this.kv.set('digest:lastSentAt', new Date().toISOString());
      this.log.log(`Summary ${result.delivered ? 'sent' : 'not delivered'}`);
      return result.delivered;
    } finally {
      this.sending = false;
    }
  }
}
