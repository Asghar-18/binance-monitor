/** Formatting for Telegram messages. */

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function pkr(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : 4;
  const text = `Rs ${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  return n < 0 ? `−${text}` : text;
}

export function usd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs >= 1 ? 2 : 4;
  const text = `$${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  return n < 0 ? `−${text}` : text;
}

export function money(n: number | null, currency: 'PKR' | 'USD', signed = false): string {
  const text = currency === 'PKR' ? pkr(n) : usd(n);
  return signed && n !== null && n > 0 ? `+${text}` : text;
}

export function pct(n: number | null, signed = true): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const text = `${Math.abs(n).toFixed(1)}%`;
  if (n < 0) return `−${text}`;
  return signed && n > 0 ? `+${text}` : text;
}

/** Threshold label: -5 -> "−5%", 10 -> "+10%" */
export const thr = (t: number) => `${t < 0 ? '−' : '+'}${Math.abs(t)}%`;

export function clock(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone });
}
