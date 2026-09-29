import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { AppConfig, CONFIG, parseThresholds } from '../config';
import { PortfolioService } from '../portfolio/portfolio.service';
import { AlertService } from './alert.service';
import { parseDuration } from './engine';
import { clock, escapeHtml, money, pct, thr } from './format';
import { TelegramClient, TelegramError } from './telegram.client';

interface Update {
  update_id: number;
  message?: { text?: string; chat: { id: number; type: string } };
}

const HELP = [
  '<b>Commands</b>',
  '/portfolio – value and P/L of each coin',
  '/alerts – your alert thresholds',
  '/set XLM -5 -10 +10 +20 – change a coin’s thresholds',
  '/set XLM off – remove a coin’s alerts',
  '/mute XLM 6h – pause alerts for a coin (m, h or d)',
  '/unmute XLM – resume alerts',
  '/status – connection status',
].join('\n');

const ASSET = /^[A-Z0-9]{1,20}$/;

/** Long-polls Telegram for commands from the owner's chat. */
@Injectable()
export class TelegramBotService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('TelegramBot');
  private stopped = false;
  private abort = new AbortController();
  private offset = 0;
  private readonly startedAt = Date.now();

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly telegram: TelegramClient,
    private readonly alerts: AlertService,
    private readonly portfolio: PortfolioService,
  ) {}

  onApplicationBootstrap() {
    if (!this.telegram.configured || !this.telegram.botUsername) return;
    void this.telegram
      .call('setMyCommands', {
        commands: [
          { command: 'portfolio', description: 'Value and P/L of each coin' },
          { command: 'alerts', description: 'Your alert thresholds' },
          { command: 'set', description: 'Change thresholds, e.g. /set XLM -5 -10 +10' },
          { command: 'mute', description: 'Pause alerts, e.g. /mute XLM 6h' },
          { command: 'unmute', description: 'Resume alerts for a coin' },
          { command: 'status', description: 'Connection status' },
          { command: 'help', description: 'All commands' },
        ],
      })
      .catch((e) => this.log.warn(`setMyCommands failed: ${(e as Error).message}`));
    void this.loop();
  }

  onModuleDestroy() {
    this.stopped = true;
    this.abort.abort();
  }

  private async loop() {
    while (!this.stopped) {
      try {
        const updates = await this.telegram.call<Update[]>(
          'getUpdates',
          { offset: this.offset, timeout: 50, allowed_updates: ['message'] },
          65_000,
          this.abort.signal,
        );
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.message?.text) await this.handle(u.message.chat, u.message.text.trim());
        }
      } catch (e) {
        if (this.stopped) return;
        const err = e as TelegramError;
        if (err.code === 409) {
          this.log.warn('Another copy of this bot is polling for commands (only one can). Retrying in 30s.');
          await new Promise((r) => setTimeout(r, 30_000));
        } else {
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    }
  }

  private async handle(chat: { id: number; type: string }, text: string) {
    const chatId = String(chat.id);
    const [rawCmd, ...args] = text.split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@.*$/, '');

    if (!this.telegram.linked) {
      if (chat.type === 'private' && cmd === '/start' && this.telegram.linkCode && args[0] === this.telegram.linkCode) {
        await this.telegram.link(chatId);
        this.log.log('Telegram chat linked');
        await this.telegram.send(`✅ Linked. Alerts for your portfolio will arrive here.\n\n${HELP}`);
      } else if (chat.type === 'private') {
        await this.telegram.send('This bot is private. Open the link shown on your dashboard to connect it.', { chatId });
      }
      return;
    }
    if (!this.telegram.isOwner(chatId)) return; // ignore everyone else silently

    try {
      const reply = await this.command(cmd, args.map((a) => a.toUpperCase()), args);
      await this.telegram.send(reply);
    } catch (e) {
      await this.telegram.send(`⚠️ ${escapeHtml((e as Error).message)}`);
    }
  }

  private async command(cmd: string, upper: string[], raw: string[]): Promise<string> {
    switch (cmd) {
      case '/start':
      case '/help':
        return HELP;
      case '/portfolio':
        return this.portfolioText();
      case '/alerts':
        return this.alertsText();
      case '/set': {
        const [asset, ...values] = upper;
        if (!asset || !ASSET.test(asset) || values.length === 0) return 'Usage: /set XLM -5 -10 +10 +20  or  /set XLM off';
        const thresholds = values[0] === 'OFF' ? [] : parseThresholds(raw.slice(1).join(' '));
        await this.alerts.setThresholds(asset, thresholds);
        return thresholds.length
          ? `✅ ${asset} alerts: ${thresholds.map(thr).join(', ')}`
          : `✅ ${asset} alerts removed. Add them back with /set ${asset} -5 -10 +10 +20`;
      }
      case '/mute': {
        const [asset, duration] = upper;
        const ms = duration ? parseDuration(duration) : null;
        if (!asset || !ASSET.test(asset) || !ms) return 'Usage: /mute XLM 6h  (m = minutes, h = hours, d = days, up to 30d)';
        const until = await this.alerts.mute(asset, ms);
        return `🔕 ${asset} muted until ${clock(until, this.cfg.TIMEZONE)}${ms >= 86_400_000 ? ` on ${new Date(until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: this.cfg.TIMEZONE })}` : ''}.`;
      }
      case '/unmute': {
        const [asset] = upper;
        if (!asset || !ASSET.test(asset)) return 'Usage: /unmute XLM';
        await this.alerts.unmute(asset);
        return `🔔 ${asset} alerts are on again.`;
      }
      case '/status':
        return this.statusText();
      default:
        return `Unknown command.\n\n${HELP}`;
    }
  }

  private portfolioText(): string {
    const snap = this.portfolio.getSnapshot();
    if (!snap) return 'Still loading your portfolio. Try again in a minute.';
    const cur = snap.fx.usdPkr ? 'PKR' : 'USD';
    const total = cur === 'PKR' ? snap.totals.valuePkr : snap.totals.valueUsd;
    const pnl = cur === 'PKR' ? snap.totals.pnlPkr : snap.totals.pnlUsd;
    const pnlPct = cur === 'PKR' ? snap.totals.pnlPkrPct : snap.totals.pnlUsdPct;
    const lines = [`<b>Portfolio: ${money(total, cur)}</b>`];
    if (pnl !== null) lines.push(`P/L ${money(pnl, cur, true)} (${pct(pnlPct)})`);
    lines.push('');
    for (const p of snap.positions) {
      const value = cur === 'PKR' ? p.valuePkr : p.valueUsd;
      const pp = cur === 'PKR' ? p.pnl.pkrPct : p.pnl.usdPct;
      lines.push(`<b>${escapeHtml(p.asset)}</b>  ${money(value, cur)}  ${p.isStable ? '' : pp !== null ? pct(pp) : 'no entry'}`.trimEnd());
    }
    if (snap.positions.length === 0) lines.push('No coins above the dust threshold.');
    return lines.join('\n');
  }

  private alertsText(): string {
    const rules = this.alerts.listRules();
    const hy = this.cfg.ALERT_HYSTERESIS_PCT;
    const lines = ['<b>Your alerts</b> (P/L from your average entry)', ''];
    const assets = [...rules.keys()].filter((a) => (rules.get(a) ?? []).length > 0).sort();
    for (const asset of assets) {
      const list = rules.get(asset)!;
      const fired = list.filter((r) => !r.armed);
      let line = `<b>${asset}</b>: ${list.map((r) => thr(r.thresholdPct)).join(', ')}`;
      if (fired.length) {
        line += `\n   fired: ${fired
          .map((r) => `${thr(r.thresholdPct)} (re-arms ${r.thresholdPct < 0 ? 'above' : 'below'} ${thr(r.thresholdPct < 0 ? r.thresholdPct + hy : r.thresholdPct - hy)})`)
          .join(', ')}`;
      }
      const muted = this.alerts.mutedUntil(asset);
      if (muted) line += `\n   🔕 muted until ${clock(muted, this.cfg.TIMEZONE)}`;
      lines.push(line);
    }
    if (assets.length === 0) lines.push(`No alerts yet. New coins get ${this.cfg.DEFAULT_THRESHOLDS.map(thr).join(', ')} automatically.`);
    lines.push('', 'Change with /set XLM -5 -10 +10 +20');
    return lines.join('\n');
  }

  private statusText(): string {
    const snap = this.portfolio.getSnapshot();
    const up = Math.round((Date.now() - this.startedAt) / 60_000);
    return [
      '<b>Status</b>',
      `Live prices: ${snap?.status.liveFeed ? 'connected' : 'reconnecting'}`,
      `Balances checked at ${snap?.status.lastBalanceSync ? clock(Date.parse(snap.status.lastBalanceSync), this.cfg.TIMEZONE) : 'never'}`,
      `USD/PKR: ${snap?.fx.usdPkr?.toFixed(2) ?? 'not loaded'}`,
      `Running for ${up >= 120 ? `${Math.round(up / 60)} hours` : `${up} minutes`}`,
    ].join('\n');
  }
}
