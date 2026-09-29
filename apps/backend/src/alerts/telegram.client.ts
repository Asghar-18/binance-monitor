import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomInt } from 'crypto';
import { AppConfig, CONFIG } from '../config';
import { KvService } from '../db/kv.service';

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram error ${code}: ${message}`);
  }
}

export interface SendOptions {
  silent?: boolean;
  /** Adds an "Open dashboard" button (https only; Telegram rejects other URLs) */
  buttonUrl?: string;
  chatId?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Telegram Bot API client. Talks to exactly one chat: the owner's.
 * The chat is linked once with a one-time code (see TelegramBotService) and stored in the database.
 */
@Injectable()
export class TelegramClient implements OnModuleInit {
  private readonly log = new Logger('Telegram');
  private chatId: string | null = null;
  linkCode: string | null = null;
  botUsername: string | null = null;

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly kv: KvService,
  ) {}

  get configured(): boolean {
    return !!this.cfg.TELEGRAM_BOT_TOKEN;
  }

  get linked(): boolean {
    return !!this.chatId;
  }

  isOwner(chatId: string | number): boolean {
    return this.chatId !== null && String(chatId) === this.chatId;
  }

  linkUrl(): string | null {
    return this.linkCode && this.botUsername ? `https://t.me/${this.botUsername}?start=${this.linkCode}` : null;
  }

  async onModuleInit() {
    if (!this.configured) {
      this.log.log('TELEGRAM_BOT_TOKEN not set; phone alerts are off');
      return;
    }
    try {
      const me = await this.call<{ username: string }>('getMe', {});
      this.botUsername = me.username;
    } catch (e) {
      this.log.error(`Bot token rejected: ${(e as Error).message}`);
      return;
    }
    this.chatId = this.cfg.TELEGRAM_CHAT_ID ?? (await this.kv.get('telegram:chatId'));
    if (!this.chatId) {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      this.linkCode = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
      this.log.log(`Link Telegram: open ${this.linkUrl()} and press Start (or send "/start ${this.linkCode}" to @${this.botUsername})`);
    } else {
      this.log.log(`Telegram linked to @${this.botUsername}`);
    }
  }

  async link(chatId: string): Promise<void> {
    await this.kv.set('telegram:chatId', chatId);
    this.chatId = chatId;
    this.linkCode = null;
  }

  async call<T>(method: string, body: object, timeoutMs = 15_000, signal?: AbortSignal): Promise<T> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    const res = await fetch(`https://api.telegram.org/bot${this.cfg.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    const json = (await res.json()) as {
      ok: boolean;
      result: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!json.ok) throw new TelegramError(json.error_code ?? res.status, json.description ?? 'unknown', json.parameters?.retry_after);
    return json.result;
  }

  /** Sends a message to the owner (or chatId). Retries up to 3 times. Returns true if delivered. */
  async send(html: string, opts: SendOptions = {}): Promise<boolean> {
    const chatId = opts.chatId ?? this.chatId;
    if (!this.configured || !chatId) return false;
    const replyMarkup =
      opts.buttonUrl && opts.buttonUrl.startsWith('https://')
        ? { inline_keyboard: [[{ text: 'Open dashboard', url: opts.buttonUrl }]] }
        : undefined;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.call('sendMessage', {
          chat_id: chatId,
          text: html,
          parse_mode: 'HTML',
          disable_notification: !!opts.silent,
          link_preview_options: { is_disabled: true },
          reply_markup: replyMarkup,
        });
        return true;
      } catch (e) {
        const err = e as TelegramError;
        this.log.warn(`Send failed (attempt ${attempt}): ${err.message}`);
        if (err.code === 400 || err.code === 401 || err.code === 403) return false; // will not succeed on retry
        await sleep(err.retryAfter ? err.retryAfter * 1000 : 2000 * attempt);
      }
    }
    return false;
  }
}
