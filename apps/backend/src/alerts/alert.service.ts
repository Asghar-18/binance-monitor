import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { and, desc, eq } from 'drizzle-orm';
import type { AlertItem, AlertKind, AlertStatus, Currency, PortfolioSnapshot, Position } from '@bpm/shared';
import { AppConfig, CONFIG } from '../config';
import { DB, Db } from '../db/tokens';
import { KvService } from '../db/kv.service';
import { alertRules, alerts } from '../db/schema';
import { PortfolioService } from '../portfolio/portfolio.service';
import { evaluate, isCrossed, isQuietHour, LastAlert, passesCooldown, RuleState } from './engine';
import { money, pct, thr } from './format';
import { AlertMessage, NotifierService } from './notifier.service';
import { NtfyClient } from './ntfy.client';
import { TelegramClient } from './telegram.client';

interface Rule extends RuleState {
  asset: string;
}

/** P/L % used for alerts: PKR when available, otherwise USD. */
function alertPnl(p: Position): { value: number; currency: Currency } | null {
  if (p.pnl.pkrPct !== null) return { value: p.pnl.pkrPct, currency: 'PKR' };
  if (p.pnl.usdPct !== null) return { value: p.pnl.usdPct, currency: 'USD' };
  return null;
}

@Injectable()
export class AlertService implements OnApplicationBootstrap {
  private readonly log = new Logger(AlertService.name);
  private rules = new Map<string, Rule[]>();
  private initialized = new Set<string>();
  private mutes = new Map<string, number>();
  private lastAlert = new Map<string, LastAlert>();
  private readonly startedAt = Date.now();
  private ticking = false;
  private loaded = false;

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(DB) private readonly db: Db,
    private readonly kv: KvService,
    private readonly portfolio: PortfolioService,
    private readonly telegram: TelegramClient,
    private readonly ntfy: NtfyClient,
    private readonly notifier: NotifierService,
  ) {}

  async onApplicationBootstrap() {
    const rows = await this.db.select().from(alertRules);
    for (const r of rows) this.addRule({ id: r.id, asset: r.asset, thresholdPct: r.thresholdPct, armed: r.armed, watchSent: r.watchSent });
    for (const { key } of await this.kv.byPrefix('rules-init:')) this.initialized.add(key.slice('rules-init:'.length));
    for (const { key, value } of await this.kv.byPrefix('mute:')) this.mutes.set(key.slice('mute:'.length), Number(value));

    const sent = await this.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.kind, 'threshold'), eq(alerts.status, 'sent')))
      .orderBy(desc(alerts.createdAt))
      .limit(200);
    for (const a of sent) {
      if (!this.lastAlert.has(a.asset)) this.lastAlert.set(a.asset, { at: a.createdAt.getTime(), thresholdPct: a.thresholdPct });
    }

    this.portfolio.onEntryChanged((asset) => void this.resetArming(asset));
    this.loaded = true;
    this.log.log(`Alert engine ready (${rows.length} thresholds; first check in ${this.cfg.ALERT_STARTUP_GRACE_SEC}s)`);
  }

  // ---------------------------------------------------------------- engine loop

  @Interval(5_000)
  async tick(): Promise<void> {
    if (!this.loaded || this.ticking) return;
    if (Date.now() - this.startedAt < this.cfg.ALERT_STARTUP_GRACE_SEC * 1000) return;
    if (!this.portfolio.pricesFresh()) return; // FR-4.9: never alert on stale data
    const snap = this.portfolio.getSnapshot();
    if (!snap) return;

    this.ticking = true;
    try {
      for (const p of snap.positions) {
        if (p.isStable) continue;
        const pnl = alertPnl(p);
        if (!pnl) continue;
        await this.ensureRules(p.asset, pnl.value);
        await this.evaluatePosition(p, pnl.value, pnl.currency);
      }
    } catch (e) {
      this.log.error(`Alert check failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async evaluatePosition(p: Position, pnl: number, currency: Currency) {
    const rules = this.rules.get(p.asset) ?? [];
    if (rules.length === 0) return;
    const ev = evaluate(rules, pnl, { hysteresis: this.cfg.ALERT_HYSTERESIS_PCT, watchMargin: this.cfg.WATCH_MARGIN_PCT });

    const changes = new Map<number, Partial<Pick<Rule, 'armed' | 'watchSent'>>>();
    for (const id of ev.disarm) changes.set(id, { ...changes.get(id), armed: false, watchSent: true });
    for (const id of ev.rearm) changes.set(id, { ...changes.get(id), armed: true, watchSent: false });
    for (const id of ev.resetWatch) changes.set(id, { ...changes.get(id), watchSent: false });
    if (ev.watch) changes.set(ev.watch.id, { ...changes.get(ev.watch.id), watchSent: true });
    await this.applyChanges(rules, changes);

    if (ev.fire) await this.dispatch(p, 'threshold', ev.fire.thresholdPct, pnl, currency);
    else if (ev.watch) await this.dispatch(p, 'watch', ev.watch.thresholdPct, pnl, currency);
  }

  private async applyChanges(rules: Rule[], changes: Map<number, Partial<Pick<Rule, 'armed' | 'watchSent'>>>) {
    for (const [id, change] of changes) {
      const rule = rules.find((r) => r.id === id);
      if (!rule) continue;
      Object.assign(rule, change);
      await this.db.update(alertRules).set(change).where(eq(alertRules.id, id));
    }
  }

  private async dispatch(p: Position, kind: AlertKind, thresholdPct: number, pnl: number, currency: Currency) {
    const now = Date.now();
    const last = this.lastAlert.get(p.asset);
    const cooldownMs = this.cfg.ALERT_COOLDOWN_MIN * 60_000;
    const msg = kind === 'threshold' ? this.thresholdMessage(p, thresholdPct, pnl, currency) : this.watchMessage(p, thresholdPct, pnl);
    const message = [msg.title, ...msg.lines].join('\n');

    let status: AlertStatus;
    if ((this.mutes.get(p.asset) ?? 0) > now) status = 'muted';
    else if (kind === 'threshold' && !passesCooldown(thresholdPct, last, now, cooldownMs)) status = 'suppressed';
    else if (kind === 'watch' && last && now - last.at < cooldownMs) status = 'suppressed';
    else if (kind === 'watch' && isQuietHour(new Date(now), this.cfg.QUIET_HOURS, this.cfg.TIMEZONE)) status = 'quiet';
    else if (!this.notifier.anyChannel) status = 'not_linked';
    else status = (await this.notifier.send(msg)).delivered ? 'sent' : 'failed';

    if (kind === 'threshold' && status === 'sent') this.lastAlert.set(p.asset, { at: now, thresholdPct });
    await this.db.insert(alerts).values({
      asset: p.asset,
      kind,
      thresholdPct,
      pnlPct: pnl,
      currency,
      priceUsd: p.priceUsd,
      status,
      message,
    });
    this.log.log(`${kind} alert ${p.asset} ${thr(thresholdPct)} at ${pct(pnl)}: ${status}`);
  }

  // ---------------------------------------------------------------- messages

  private thresholdMessage(p: Position, t: number, pnl: number, currency: Currency): AlertMessage {
    const priceLocal = currency === 'PKR' && p.valuePkr !== null ? p.valuePkr / p.quantity : p.priceUsd;
    const avg = currency === 'PKR' ? p.entry.avgPkr : p.entry.avgUsd;
    const pnlAbs = currency === 'PKR' ? p.pnl.pkr : p.pnl.usd;
    const next = (this.rules.get(p.asset) ?? [])
      .filter((r) => Math.sign(r.thresholdPct) === Math.sign(t) && Math.abs(r.thresholdPct) > Math.abs(t))
      .sort((a, b) => Math.abs(a.thresholdPct) - Math.abs(b.thresholdPct))[0];

    const lines = [
      `Crossed your ${thr(t)} alert.`,
      `Price: ${money(priceLocal, currency)}${currency === 'PKR' ? ` (${money(p.priceUsd, 'USD')})` : ''}`,
      `Your average: ${money(avg, currency)}`,
      `P/L: ${money(pnlAbs, currency, true)} (${pct(pnl)})`,
    ];
    if (p.change24hPct !== null) lines.push(`24h: ${pct(p.change24hPct)}`);
    if (p.entry.source === 'partial') lines.push(`Entry covers ${Math.round(p.entry.coveragePct ?? 0)}% of your coins.`);
    lines.push(next ? `Next alert: ${thr(next.thresholdPct)}` : 'No further alerts in this direction.');
    return { severity: t < 0 ? 'loss' : 'gain', title: `${p.asset} is ${pct(pnl)} from your entry`, lines };
  }

  private watchMessage(p: Position, t: number, pnl: number): AlertMessage {
    return { severity: 'watch', title: `${p.asset} is ${pct(pnl)}`, lines: [`Close to your ${thr(t)} alert.`] };
  }

  // ---------------------------------------------------------------- rules management

  private addRule(r: Rule) {
    const list = this.rules.get(r.asset) ?? [];
    list.push(r);
    list.sort((a, b) => a.thresholdPct - b.thresholdPct);
    this.rules.set(r.asset, list);
  }

  /** New coins get the default thresholds once. Thresholds already crossed start disarmed (no alert flood). */
  private async ensureRules(asset: string, pnl: number) {
    if (this.initialized.has(asset)) return;
    await this.replaceRules(asset, this.cfg.DEFAULT_THRESHOLDS, pnl);
  }

  private async replaceRules(asset: string, thresholds: number[], pnl: number | null) {
    await this.db.delete(alertRules).where(eq(alertRules.asset, asset));
    this.rules.delete(asset);
    if (thresholds.length > 0) {
      const inserted = await this.db
        .insert(alertRules)
        .values(thresholds.map((t) => ({ asset, thresholdPct: t, armed: pnl === null || !isCrossed(t, pnl), watchSent: false })))
        .returning();
      for (const r of inserted) this.addRule({ id: r.id, asset, thresholdPct: r.thresholdPct, armed: r.armed, watchSent: r.watchSent });
    }
    await this.kv.set(`rules-init:${asset}`, '1');
    this.initialized.add(asset);
  }

  private currentPnl(asset: string): number | null {
    const p = this.portfolio.getSnapshot()?.positions.find((x) => x.asset === asset);
    return p ? (alertPnl(p)?.value ?? null) : null;
  }

  async setThresholds(asset: string, thresholds: number[]): Promise<void> {
    await this.replaceRules(asset, thresholds, this.currentPnl(asset));
  }

  /** After an entry price change, re-arm silently based on the new P/L. */
  async resetArming(asset: string): Promise<void> {
    const pnl = this.currentPnl(asset);
    const rules = this.rules.get(asset);
    if (!rules || pnl === null) return;
    const changes = new Map(rules.map((r) => [r.id, { armed: !isCrossed(r.thresholdPct, pnl), watchSent: false }]));
    await this.applyChanges(rules, changes);
  }

  async mute(asset: string, ms: number): Promise<number> {
    const until = Date.now() + ms;
    this.mutes.set(asset, until);
    await this.kv.set(`mute:${asset}`, String(until));
    return until;
  }

  async unmute(asset: string): Promise<void> {
    this.mutes.delete(asset);
    await this.kv.delete(`mute:${asset}`);
  }

  listRules(): Map<string, Rule[]> {
    return this.rules;
  }

  mutedUntil(asset: string): number | null {
    const until = this.mutes.get(asset);
    return until && until > Date.now() ? until : null;
  }

  // ---------------------------------------------------------------- dashboard

  async recent(limit = 10): Promise<AlertItem[]> {
    const rows = await this.db.select().from(alerts).orderBy(desc(alerts.createdAt)).limit(limit);
    return rows.map((r) => ({
      id: r.id,
      asset: r.asset,
      kind: r.kind as AlertKind,
      thresholdPct: r.thresholdPct,
      pnlPct: r.pnlPct,
      currency: r.currency as Currency,
      status: r.status as AlertStatus,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Adds alert settings and recent alerts to a portfolio snapshot. */
  async decorate(base: ReturnType<PortfolioService['getSnapshot']>): Promise<PortfolioSnapshot | null> {
    if (!base) return null;
    const positions = base.positions.map((p) => {
      if (p.isStable) return p;
      const rules = this.rules.get(p.asset);
      const thresholds = rules
        ? rules.map((r) => ({ pct: r.thresholdPct, armed: r.armed }))
        : this.cfg.DEFAULT_THRESHOLDS.map((t) => ({ pct: t, armed: true }));
      const until = this.mutedUntil(p.asset);
      return {
        ...p,
        alerts: {
          thresholds,
          mutedUntil: until ? new Date(until).toISOString() : null,
          currency: (p.pnl.pkrPct !== null ? 'PKR' : 'USD') as Currency,
        },
      };
    });
    return {
      ...base,
      positions,
      status: {
        ...base.status,
        ntfy: { configured: this.ntfy.configured },
        telegram: {
          configured: this.telegram.configured,
          linked: this.telegram.linked,
          linkCode: this.telegram.linkCode,
          linkUrl: this.telegram.linkUrl(),
        },
      },
      alerts: await this.recent(10),
    };
  }
}
