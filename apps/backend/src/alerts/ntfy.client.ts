import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';

export interface NtfyMessage {
  title: string;
  message: string;
  /** 1 = min (no sound) ... 5 = max (long vibration, pop-over) */
  priority: 1 | 2 | 3 | 4 | 5;
  /** Emoji shortcodes shown next to the title, e.g. "rotating_light" */
  tags?: string[];
  /** Opened when the notification is tapped */
  click?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Publishes push notifications through ntfy (https://ntfy.sh).
 * The phone subscribes to the topic in the ntfy app; no bot, account or VPN needed.
 */
@Injectable()
export class NtfyClient {
  private readonly log = new Logger('Ntfy');

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {
    if (cfg.NTFY_TOPIC) this.log.log(`Push alerts go to ntfy topic on ${cfg.NTFY_URL}`);
  }

  get configured(): boolean {
    return !!this.cfg.NTFY_TOPIC;
  }

  /** Returns true if ntfy accepted the message. Retries up to 3 times. */
  async send(msg: NtfyMessage): Promise<boolean> {
    if (!this.cfg.NTFY_TOPIC) return false;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.NTFY_TOKEN) headers.authorization = `Bearer ${this.cfg.NTFY_TOKEN}`;
    const url = this.cfg.NTFY_URL.replace(/\/+$/, '');
    const body = {
      topic: this.cfg.NTFY_TOPIC,
      title: msg.title,
      message: msg.message,
      priority: msg.priority,
      tags: msg.tags,
      click: msg.click,
      actions: msg.click ? [{ action: 'view', label: 'Open dashboard', url: msg.click, clear: true }] : undefined,
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
        if (res.ok) return true;
        const text = (await res.text()).slice(0, 200);
        this.log.warn(`ntfy rejected message (HTTP ${res.status}, attempt ${attempt}): ${text}`);
        if (res.status === 400 || res.status === 401 || res.status === 403) return false;
        if (res.status === 429) await sleep(10_000);
      } catch (e) {
        this.log.warn(`ntfy send failed (attempt ${attempt}): ${(e as Error).message}`);
      }
      await sleep(2000 * attempt);
    }
    return false;
  }
}
