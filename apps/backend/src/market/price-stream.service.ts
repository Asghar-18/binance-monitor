import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import { AppConfig, CONFIG } from '../config';
import { MarketService } from './market.service';

interface MiniTickerMsg {
  stream: string;
  data: { e: string; s: string; c: string; o: string };
}

const STALE_AFTER_MS = 60_000;
/** Binance closes connections after 24h; reconnect a little earlier on our own terms. */
const ROTATE_AFTER_MS = 23 * 60 * 60 * 1000;

/**
 * Live prices from Binance's combined mini-ticker stream.
 * Updates MarketService in place; reconnects with backoff and rotates before the 24h limit.
 */
@Injectable()
export class PriceStreamService implements OnModuleDestroy {
  private readonly log = new Logger(PriceStreamService.name);
  private ws: WebSocket | null = null;
  private symbols: string[] = [];
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private rotateTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  lastMessageAt = 0;

  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly market: MarketService,
  ) {}

  isLive(): boolean {
    return Date.now() - this.lastMessageAt < STALE_AFTER_MS;
  }

  /** Subscribe to exactly these symbols (e.g. XLMUSDT). BTCUSDT is always added as a heartbeat. */
  setSymbols(list: string[]): void {
    const next = [...new Set([...list, 'BTCUSDT'].map((s) => s.toUpperCase()))].sort();
    if (next.join(',') === this.symbols.join(',') && this.ws) return;
    this.symbols = next;
    this.connect();
  }

  private connect(): void {
    this.clearTimers();
    const old = this.ws;
    this.ws = null;
    old?.removeAllListeners();
    old?.terminate();
    if (this.stopped || this.symbols.length === 0) return;

    const streams = this.symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join('/');
    const ws = new WebSocket(`${this.cfg.BINANCE_WS_URL}/stream?streams=${streams}`);
    this.ws = ws;

    ws.on('open', () => {
      this.attempts = 0;
      this.log.log(`Live prices connected (${this.symbols.length} symbols)`);
      this.rotateTimer = setTimeout(() => {
        this.log.log('Rotating price stream before the 24h limit');
        this.connect();
      }, ROTATE_AFTER_MS);
    });

    ws.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(raw.toString()) as MiniTickerMsg;
        if (msg.data?.e === '24hrMiniTicker') {
          this.market.applyTicker(msg.data.s, Number(msg.data.c), Number(msg.data.o));
        }
      } catch {
        /* ignore malformed frames */
      }
    });

    ws.on('error', (e) => this.log.warn(`Price stream error: ${e.message}`));

    ws.on('close', (code) => {
      if (ws !== this.ws || this.stopped) return; // replaced or shutting down
      this.attempts++;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempts, 6));
      this.log.warn(`Price stream closed (code ${code}); reconnecting in ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.reconnectTimer = null;
    this.rotateTimer = null;
  }

  onModuleDestroy() {
    this.stopped = true;
    this.clearTimers();
    this.ws?.removeAllListeners();
    this.ws?.terminate();
  }
}
