/**
 * Builds the JSON Claude sees. Every number is pre-formatted here, in the user's currency,
 * so the guardrail can check Claude only repeats numbers that were given.
 */
import type { Currency, Position, Timeframe } from '@bpm/shared';
import { money, pct } from '../alerts/format';
import type { TechnicalDetail } from './technical.service';

/** Removes null/undefined fields (recursively) so Claude never sees or repeats "null". */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0))
        .map(([k, v]) => [k, compact(v)]),
    ) as T;
  }
  return value;
}

const round = (n: number | null | undefined, d = 0) => (n === null || n === undefined ? null : Number(n.toFixed(d)));

export function positionInput(p: Position, tech: TechnicalDetail | null, currency: Currency, event: string | null) {
  const rate = currency === 'PKR' && p.valueUsd && p.valuePkr ? p.valuePkr / p.valueUsd : 1;
  const local = (usd: number | null | undefined) => (usd === null || usd === undefined ? null : money(usd * rate, currency));
  const pnlPct = currency === 'PKR' ? p.pnl.pkrPct : p.pnl.usdPct;
  const avg = currency === 'PKR' ? p.entry.avgPkr : p.entry.avgUsd;

  const timeframes: Record<string, object> = {};
  for (const tf of ['1h', '4h', '1d'] as Timeframe[]) {
    const t = tech?.timeframes[tf];
    if (!t) continue;
    timeframes[tf] = {
      trend: t.trend,
      rsi: round(t.rsi),
      volume_vs_average: t.volumeRatio !== null ? `${t.volumeRatio.toFixed(1)}x` : null,
    };
  }

  return compact({
    event,
    coin: p.asset,
    price: local(p.priceUsd),
    ...(currency === 'PKR' ? { price_usd: money(p.priceUsd, 'USD') } : {}),
    average_entry: money(avg, currency),
    pnl_from_entry: pct(pnlPct),
    change_24h: pct(p.change24hPct),
    share_of_portfolio: pct(p.sharePct, false),
    timeframes,
    ema50_4h: local(tech?.ema50_4h),
    ema200_1d: local(tech?.ema200_1d),
    nearest_support: local(tech?.supportUsd),
    nearest_resistance: local(tech?.resistanceUsd),
    daily_volatility_atr: tech?.timeframes['1d']?.atrPct !== undefined ? pct(tech.timeframes['1d']!.atrPct, false) : null,
  });
}

export function digestInput(
  positions: { p: Position; tech: TechnicalDetail | null }[],
  totals: { value: number | null; change24h: number | null; change24hPct: number | null; pnl: number | null; pnlPct: number | null },
  currency: Currency,
  alertsLast24h: number,
) {
  return compact({
    event: 'Morning portfolio summary',
    total_value: money(totals.value, currency),
    change_24h: totals.change24hPct !== null ? `${pct(totals.change24hPct)} (${money(totals.change24h, currency, true)})` : null,
    pnl_from_entry: totals.pnl !== null ? `${money(totals.pnl, currency, true)} (${pct(totals.pnlPct)})` : null,
    alerts_last_24h: alertsLast24h,
    coins: positions.map(({ p, tech }) => ({
      coin: p.asset,
      value: money(currency === 'PKR' ? p.valuePkr : p.valueUsd, currency),
      share: pct(p.sharePct, false),
      change_24h: pct(p.change24hPct),
      pnl_from_entry: p.isStable ? null : pct(currency === 'PKR' ? p.pnl.pkrPct : p.pnl.usdPct),
      trend_1d: tech?.timeframes['1d']?.trend ?? null,
      rsi_1d: round(tech?.timeframes['1d']?.rsi),
    })),
  });
}

/** Deterministic lines for notifications, shown whether or not Claude is available. */
export function technicalLines(p: Position, tech: TechnicalDetail | null, currency: Currency): string[] {
  if (!tech) return [];
  const rate = currency === 'PKR' && p.valueUsd && p.valuePkr ? p.valuePkr / p.valueUsd : 1;
  const trends = (['1h', '4h', '1d'] as Timeframe[]).map((tf) => tech.timeframes[tf]?.trend ?? '?');
  const lines = [`Trend 1h/4h/1d: ${trends.join(' / ')}`];
  const rsi = tech.timeframes['1h']?.rsi;
  const vol = tech.timeframes['1h']?.volumeRatio;
  if (rsi !== null && rsi !== undefined) lines.push(`RSI 1h: ${rsi.toFixed(0)}${vol ? `, volume ${vol.toFixed(1)}x average` : ''}`);
  const s = tech.supportUsd !== null ? money(tech.supportUsd * rate, currency) : null;
  const r = tech.resistanceUsd !== null ? money(tech.resistanceUsd * rate, currency) : null;
  if (s && r) lines.push(`Support ${s}, resistance ${r}`);
  else if (s) lines.push(`Support ${s} (no resistance level nearby)`);
  else if (r) lines.push(`Resistance ${r} (price is below recent support levels)`);
  return lines;
}
