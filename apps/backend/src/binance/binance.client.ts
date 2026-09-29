import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { AppConfig, CONFIG } from '../config';

export class BinanceError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
    readonly path: string,
  ) {
    super(`Binance ${path} failed (${status}${code !== undefined ? `, code ${code}` : ''}): ${message}`);
  }
}

type Params = Record<string, string | number | boolean | undefined>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal Binance REST client: public + HMAC-signed GET requests,
 * server-time sync, and backoff on rate limits (HTTP 429/418).
 * Only GET is implemented on purpose: this app never places orders.
 */
@Injectable()
export class BinanceClient {
  private readonly log = new Logger(BinanceClient.name);
  private timeOffsetMs = 0;
  private timeSynced = false;
  /** Last reported request weight used in the current minute */
  usedWeight1m = 0;

  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {}

  async syncTime(): Promise<void> {
    const before = Date.now();
    const { serverTime } = await this.get<{ serverTime: number }>('/api/v3/time');
    const after = Date.now();
    this.timeOffsetMs = serverTime - Math.round((before + after) / 2);
    this.timeSynced = true;
  }

  get<T>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>(path, params, false, 0);
  }

  async signedGet<T>(path: string, params: Params = {}): Promise<T> {
    if (!this.timeSynced) await this.syncTime();
    return this.request<T>(path, params, true, 0);
  }

  private async request<T>(path: string, params: Params, signed: boolean, attempt: number): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const headers: Record<string, string> = {};
    if (signed) {
      qs.set('recvWindow', '10000');
      qs.set('timestamp', String(Date.now() + this.timeOffsetMs));
      qs.set('signature', createHmac('sha256', this.cfg.BINANCE_API_SECRET).update(qs.toString()).digest('hex'));
      headers['X-MBX-APIKEY'] = this.cfg.BINANCE_API_KEY;
    }

    let res: Response;
    try {
      res = await fetch(`${this.cfg.BINANCE_BASE_URL}${path}?${qs.toString()}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      if (attempt < 2) {
        await sleep(2000 * (attempt + 1));
        return this.request<T>(path, params, signed, attempt + 1);
      }
      throw new BinanceError(0, undefined, (e as Error).message, path);
    }

    const weight = res.headers.get('x-mbx-used-weight-1m');
    if (weight) this.usedWeight1m = Number(weight);

    if (res.status === 429 || res.status === 418) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '60');
      this.log.warn(`Rate limited on ${path} (HTTP ${res.status}); retry after ${retryAfter}s`);
      if (res.status === 429 && attempt < 2 && retryAfter <= 120) {
        await sleep(retryAfter * 1000);
        return this.request<T>(path, params, signed, attempt + 1);
      }
      throw new BinanceError(res.status, undefined, `rate limited, retry after ${retryAfter}s`, path);
    }

    const text = await res.text();
    if (res.status === 451 || res.status === 403 && /restricted location|eligibility/i.test(text)) {
      throw new BinanceError(
        res.status,
        undefined,
        'Binance blocks requests from this server\'s location. Move the backend to another region (not the US) and redeploy.',
        path,
      );
    }
    if (!res.ok) {
      let code: number | undefined;
      let msg = text.slice(0, 300);
      try {
        const body = JSON.parse(text) as { code?: number; msg?: string };
        code = body.code;
        msg = body.msg ?? msg;
      } catch {
        /* not JSON */
      }
      // -1021: timestamp outside recvWindow -> resync clock once and retry
      if (code === -1021 && attempt < 1) {
        await this.syncTime();
        return this.request<T>(path, params, signed, attempt + 1);
      }
      if (res.status >= 500 && attempt < 2) {
        await sleep(2000 * (attempt + 1));
        return this.request<T>(path, params, signed, attempt + 1);
      }
      throw new BinanceError(res.status, code, msg, path);
    }
    return JSON.parse(text) as T;
  }
}
