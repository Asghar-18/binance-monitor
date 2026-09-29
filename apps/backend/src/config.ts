import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  BINANCE_API_KEY: z.string().min(10, 'BINANCE_API_KEY is missing'),
  BINANCE_API_SECRET: z.string().min(10, 'BINANCE_API_SECRET is missing'),
  BINANCE_BASE_URL: z.string().url().default('https://api.binance.com'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is missing'),
  API_TOKEN: z.string().min(24, 'API_TOKEN must be at least 24 characters'),
  PORT: z.coerce.number().int().default(4000),
  /** Quote currencies to import trade history for, e.g. BTC bought on BTCUSDT and BTCFDUSD */
  QUOTE_ASSETS: z
    .string()
    .default('USDT,FDUSD,USDC,BTC,ETH,BNB')
    .transform((s) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
  DUST_USD: z.coerce.number().default(5),
  CONVERT_LOOKBACK_DAYS: z.coerce.number().int().min(0).max(1500).default(365),
  BINANCE_WS_URL: z.string().default('wss://stream.binance.com:9443'),

  // --- ntfy push notifications (works without a VPN) --------------------
  NTFY_URL: z.string().url().default('https://ntfy.sh'),
  /** Long random topic name; anyone who knows it can read your alerts */
  NTFY_TOPIC: z
    .string()
    .optional()
    .transform((v) => v || undefined)
    .refine((v) => !v || /^[A-Za-z0-9_-]{12,64}$/.test(v), 'NTFY_TOPIC must be 12-64 letters, digits, - or _'),
  /** Optional access token for protected topics or a self-hosted server */
  NTFY_TOKEN: z.string().optional().transform((v) => v || undefined),

  // --- Telegram ---------------------------------------------------------
  TELEGRAM_BOT_TOKEN: z.string().optional().transform((v) => v || undefined),
  /** Optional: skip the /start linking step by setting the chat id directly */
  TELEGRAM_CHAT_ID: z.string().optional().transform((v) => v || undefined),
  /** https URL of the dashboard, used for the "Open dashboard" button */
  DASHBOARD_URL: z.string().optional().transform((v) => v || undefined),

  // --- Alerts -----------------------------------------------------------
  /** Thresholds (P/L % from entry) created for every coin you hold */
  DEFAULT_THRESHOLDS: z
    .string()
    .default('-5,-10,10,20')
    .transform((s) => parseThresholds(s)),
  /** A fired threshold re-arms after P/L moves back this many points */
  ALERT_HYSTERESIS_PCT: z.coerce.number().min(0).default(1),
  /** Minimum minutes between alerts for the same coin (deeper thresholds bypass it) */
  ALERT_COOLDOWN_MIN: z.coerce.number().min(0).default(120),
  /** Send a silent "approaching" alert within this many points of a threshold; 0 disables */
  WATCH_MARGIN_PCT: z.coerce.number().min(0).default(1),
  /** Hours (in TIMEZONE) when silent "approaching" alerts are skipped, e.g. 23-7; empty disables */
  QUIET_HOURS: z.string().default('23-7'),
  TIMEZONE: z.string().default('Asia/Karachi'),
  /** Do not send alerts for this many seconds after startup */
  ALERT_STARTUP_GRACE_SEC: z.coerce.number().int().min(0).default(300),

  // --- Claude analysis --------------------------------------------------
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => v || undefined),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5'),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  /** Stop calling Claude for the rest of the month after this much spend */
  LLM_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(5),

  // --- Morning summary --------------------------------------------------
  /** Local time (TIMEZONE) for the daily summary, e.g. 09:00; "off" disables */
  DIGEST_TIME: z
    .string()
    .default('09:00')
    .refine((v) => v === 'off' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'DIGEST_TIME must be HH:MM or off'),

  /** Never set this in production: lets the app start with a key that can trade or withdraw */
  ALLOW_UNSAFE_KEY: bool,
});

/** "-5, -10, +10, 20" -> [-10, -5, 10, 20]; rejects 0 and out-of-range values */
export function parseThresholds(input: string): number[] {
  const out = new Set<number>();
  for (const part of input.replace(/\u2212/g, '-').split(/[\s,]+/)) {
    if (!part) continue;
    const n = Number(part.replace(/%$/, ''));
    if (!Number.isFinite(n) || n === 0 || n < -99 || n > 1000) throw new Error(`Invalid threshold "${part}"`);
    out.add(Math.round(n * 100) / 100);
  }
  if (out.size > 10) throw new Error('At most 10 thresholds per coin');
  return [...out].sort((a, b) => a - b);
}

export type AppConfig = z.infer<typeof schema>;

export const CONFIG = Symbol('CONFIG');

export function loadConfig(): AppConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration. Check your .env file:\n${issues}`);
  }
  return parsed.data;
}

/** Stablecoins valued at 1 USD with no P/L tracking */
export const STABLECOINS = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'BUSD', 'USD1']);
