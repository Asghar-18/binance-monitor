import type { Currency } from '@bpm/shared';

const pkr0 = new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Money with sensible precision: small prices keep more decimals. */
export function money(value: number | null | undefined, currency: Currency, opts: { signed?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  let text: string;
  if (currency === 'PKR') {
    text = abs >= 100 ? pkr0.format(abs) : new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', maximumSignificantDigits: 4 }).format(abs);
    text = text.replace(/^PKR\s?/, 'Rs ');
  } else {
    text = abs >= 1 ? usd2.format(abs) : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 4 }).format(abs);
  }
  if (value < 0) return `−${text}`;
  return opts.signed && value > 0 ? `+${text}` : text;
}

export function percent(value: number | null | undefined, opts: { signed?: boolean } = { signed: true }): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const text = `${Math.abs(value).toFixed(Math.abs(value) >= 100 ? 0 : 1)}%`;
  if (value < 0) return `−${text}`;
  return opts.signed && value > 0 ? `+${text}` : text;
}

export function quantity(q: number): string {
  if (q >= 1000) return q.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (q >= 1) return q.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return q.toLocaleString('en-US', { maximumSignificantDigits: 4 });
}

export function time(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function shortDate(ymd: string | null): string {
  if (!ymd) return 'unknown date';
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function tone(v: number | null | undefined): 'gain' | 'loss' | 'flat' {
  if (v === null || v === undefined || Math.abs(v) < 0.05) return 'flat';
  return v > 0 ? 'gain' : 'loss';
}

/** Threshold label: -5 -> "−5%", 10 -> "+10%" */
export const threshold = (t: number) => `${t < 0 ? '−' : '+'}${Math.abs(t)}%`;

/** "−5, −10, +10" -> [-10, -5, 10]; throws with a readable message */
export function parseThresholdList(input: string): number[] {
  const out = new Set<number>();
  for (const part of input.replace(/\u2212/g, '-').split(/[\s,]+/)) {
    if (!part) continue;
    const n = Number(part.replace(/%$/, ''));
    if (!Number.isFinite(n) || n === 0 || n < -99 || n > 1000) throw new Error(`"${part}" is not a valid threshold`);
    out.add(n);
  }
  if (out.size > 10) throw new Error('Use at most 10 thresholds');
  return [...out].sort((a, b) => a - b);
}
