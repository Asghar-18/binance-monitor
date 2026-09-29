import 'server-only';

/** Server-side calls to the NestJS backend. The API token never reaches the browser. */
export async function backendFetch(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const base = process.env.BACKEND_URL || 'http://localhost:4000';
  const token = process.env.API_TOKEN;
  if (!token) throw new Error('API_TOKEN is not set for the dashboard');
  return fetch(`${base}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Pass a backend response through to the browser unchanged. */
export async function relay(res: Response): Promise<Response> {
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

export function unreachable(e: unknown): Response {
  return Response.json(
    { message: `Backend unreachable: ${(e as Error).message}` },
    { status: 502 },
  );
}
