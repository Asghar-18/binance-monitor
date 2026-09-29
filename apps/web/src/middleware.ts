import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/session';

const PUBLIC = ['/login', '/api/auth/login', '/robots.txt'];

/** Everything except the login page needs a valid signed session cookie. */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.includes(pathname)) return NextResponse.next();

  let ok = false;
  try {
    ok = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    return new NextResponse('Set SESSION_SECRET (at least 32 characters) for the dashboard.', { status: 500 });
  }
  if (ok) return NextResponse.next();

  if (pathname.startsWith('/api/')) return NextResponse.json({ message: 'Signed out. Reload the page to sign in.' }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
