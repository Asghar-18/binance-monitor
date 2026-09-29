import { NextResponse } from 'next/server';
import { createSession, safeEqual, SESSION_COOKIE, totpEnabled, verifyTotp } from '@/lib/session';

export const dynamic = 'force-dynamic';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.json({ message: 'DASHBOARD_PASSWORD is not set on the server.' }, { status: 500 });

  let body: { password?: unknown; code?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ message: 'Invalid request' }, { status: 400 });
  }
  const given = typeof body.password === 'string' ? body.password : '';
  const code = typeof body.code === 'string' ? body.code.replace(/\s/g, '') : '';

  let ok = safeEqual(given, password);
  if (totpEnabled()) ok = (await verifyTotp(process.env.DASHBOARD_TOTP_SECRET!, code)) && ok;

  if (!ok) {
    await sleep(1000); // slow down guessing
    return NextResponse.json(
      { message: totpEnabled() ? 'Wrong password or code.' : 'Wrong password.' },
      { status: 401 },
    );
  }

  const session = await createSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(req.url).protocol === 'https:',
    path: '/',
    maxAge: session.maxAge,
  });
  return res;
}
