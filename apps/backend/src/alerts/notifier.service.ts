import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { escapeHtml } from './format';
import { NtfyClient } from './ntfy.client';
import { TelegramClient } from './telegram.client';

export type Severity = 'loss' | 'gain' | 'watch' | 'info';

/** Channel-neutral alert content; each channel renders it its own way. */
export interface AlertMessage {
  severity: Severity;
  title: string;
  /** Plain text lines */
  lines: string[];
}

const ICON: Record<Severity, string> = { loss: '🔴', gain: '🟢', watch: '🟡', info: '🔔' };
const NTFY_TAGS: Record<Severity, string[]> = {
  loss: ['red_circle'],
  gain: ['green_circle'],
  watch: ['yellow_circle'],
  info: ['bell'],
};
const NTFY_PRIORITY: Record<Severity, 1 | 2 | 3 | 4 | 5> = { loss: 5, gain: 4, watch: 2, info: 3 };

export interface DeliveryResult {
  /** At least one channel is set up */
  anyChannel: boolean;
  /** At least one channel accepted the message */
  delivered: boolean;
  channels: { ntfy?: boolean; telegram?: boolean };
}

/** Sends alerts to every configured channel: ntfy and/or Telegram. */
@Injectable()
export class NotifierService {
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly ntfy: NtfyClient,
    private readonly telegram: TelegramClient,
  ) {}

  get anyChannel(): boolean {
    return this.ntfy.configured || this.telegram.linked;
  }

  async send(msg: AlertMessage): Promise<DeliveryResult> {
    const jobs: Promise<[keyof DeliveryResult['channels'], boolean]>[] = [];
    if (this.ntfy.configured) {
      jobs.push(
        this.ntfy
          .send({
            title: msg.title,
            message: msg.lines.join('\n') || msg.title,
            priority: NTFY_PRIORITY[msg.severity],
            tags: NTFY_TAGS[msg.severity],
            click: this.cfg.DASHBOARD_URL,
          })
          .then((ok) => ['ntfy', ok]),
      );
    }
    if (this.telegram.linked) {
      const html = [`${ICON[msg.severity]} <b>${escapeHtml(msg.title)}</b>`, ...msg.lines.map(escapeHtml)].join('\n');
      jobs.push(
        this.telegram
          .send(html, { silent: msg.severity === 'watch', buttonUrl: this.cfg.DASHBOARD_URL })
          .then((ok) => ['telegram', ok]),
      );
    }
    const results = await Promise.all(jobs);
    const channels = Object.fromEntries(results) as DeliveryResult['channels'];
    return { anyChannel: jobs.length > 0, delivered: results.some(([, ok]) => ok), channels };
  }
}
