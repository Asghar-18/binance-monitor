// Types shared by the backend and the dashboard.
// Type-only package: always import with `import type`.

/** Where an asset's average entry price comes from. */
export type EntrySource = 'history' | 'partial' | 'manual' | 'unknown';

export type Currency = 'PKR' | 'USD';

export interface Position {
  asset: string;
  /** free + locked in the Spot wallet */
  quantity: number;
  isStable: boolean;
  priceUsd: number | null;
  /** How the USD price was found, e.g. "BTCUSDT" or "XYZBTC x BTCUSDT" */
  priceRoute: string | null;
  change24hPct: number | null;
  valueUsd: number | null;
  valuePkr: number | null;
  /** Share of total portfolio value, 0-100 */
  sharePct: number | null;
  entry: {
    source: EntrySource;
    avgUsd: number | null;
    avgPkr: number | null;
    /** Share of the held quantity explained by imported trades, 0-100 */
    coveragePct: number | null;
  };
  pnl: {
    usd: number | null;
    usdPct: number | null;
    pkr: number | null;
    pkrPct: number | null;
  };
  /** Alert settings for this coin (absent for stablecoins) */
  alerts?: PositionAlerts;
}

export interface ThresholdInfo {
  /** P/L % from average entry, e.g. -5 or 10 */
  pct: number;
  /** false after it fired, until P/L moves back past the buffer */
  armed: boolean;
}

export interface PositionAlerts {
  thresholds: ThresholdInfo[];
  mutedUntil: string | null;
  currency: Currency;
}

export type AlertKind = 'threshold' | 'watch';
export type AlertStatus = 'sent' | 'failed' | 'suppressed' | 'muted' | 'quiet' | 'not_linked';

export interface AlertItem {
  id: number;
  asset: string;
  kind: AlertKind;
  thresholdPct: number;
  pnlPct: number;
  currency: Currency;
  status: AlertStatus;
  createdAt: string;
}

export interface PortfolioTotals {
  valueUsd: number;
  valuePkr: number | null;
  /** P/L over positions that have a known entry price */
  pnlUsd: number | null;
  pnlUsdPct: number | null;
  pnlPkr: number | null;
  pnlPkrPct: number | null;
  stableSharePct: number;
}

export interface PortfolioSnapshot {
  updatedAt: string;
  totals: PortfolioTotals;
  positions: Position[];
  /** Assets hidden because their value is below the dust threshold */
  hiddenDustCount: number;
  dustThresholdUsd: number;
  fx: {
    usdPkr: number | null;
    /** Date of the USD/PKR rate, YYYY-MM-DD */
    date: string | null;
    stale: boolean;
  };
  status: {
    keyReadOnly: boolean | null;
    keyWarnings: string[];
    lastBalanceSync: string | null;
    lastTradeSync: string | null;
    tradeSyncRunning: boolean;
    /** true while the WebSocket price feed is delivering updates */
    liveFeed: boolean;
    lastPriceAt: string | null;
    /** ntfy push notifications (no VPN needed) */
    ntfy: { configured: boolean };
    telegram: {
      configured: boolean;
      linked: boolean;
      /** Send "/start <code>" to the bot to link it; null once linked */
      linkCode: string | null;
      /** t.me deep link that sends the code in one tap; null once linked */
      linkUrl: string | null;
    };
    errors: string[];
  };
  /** Most recent alerts, newest first */
  alerts: AlertItem[];
}

export interface ThresholdsInput {
  thresholds: number[];
}

export interface EntryOverrideInput {
  price: number;
  currency: Currency;
}
