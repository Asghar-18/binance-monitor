import { backendFetch, relay, unreachable } from '@/lib/backend';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return await relay(await backendFetch('/api/portfolio'));
  } catch (e) {
    return unreachable(e);
  }
}
