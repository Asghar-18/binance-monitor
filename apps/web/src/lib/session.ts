/**
 * Signed session cookie and TOTP (2FA) verification.
 * Uses only Web Crypto so it runs in both the middleware (edge) and route handlers (node).
 */

export const SESSION_COOKIE = 'bpm_session';
export const SESSION_DAYS = 30;

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (at least 32 characters)');
  return s;
}

/** Cookie value: "<expiry seconds>.<signature>" */
export async function createSession(): Promise<{ value: string; maxAge: number }> {
  const maxAge = SESSION_DAYS * 86_400;
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  return { value: `${exp}.${await hmac(sessionSecret(), `v1.${exp}`)}`, maxAge };
}

export async function verifySession(value: string | undefined): Promise<boolean> {
  if (!value) return false;
  const [expText, sig] = value.split('.');
  const exp = Number(expText);
  if (!sig || !Number.isInteger(exp) || exp < Date.now() / 1000) return false;
  const expected = await hmac(sessionSecret(), `v1.${exp}`);
  return safeEqual(sig, expected);
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- TOTP (RFC 6238)

function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('DASHBOARD_TOTP_SECRET is not valid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function totpAt(secret: Uint8Array, counter: number): Promise<string> {
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey('raw', secret.buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = h[h.length - 1] & 0x0f;
  const code = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** Accepts the current 30-second code and one step either side (clock drift). */
export async function verifyTotp(base32Secret: string, code: string, now = Date.now()): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(base32Secret);
  const step = Math.floor(now / 30_000);
  for (const s of [step - 1, step, step + 1]) {
    if (safeEqual(await totpAt(secret, s), code)) return true;
  }
  return false;
}

export const totpEnabled = () => !!process.env.DASHBOARD_TOTP_SECRET;
