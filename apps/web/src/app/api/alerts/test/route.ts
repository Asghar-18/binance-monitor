import { backendFetch, relay, unreachable } from '@/lib/backend';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    return await relay(await backendFetch('/api/alerts/test', { method: 'POST' }));
  } catch (e) {
    return unreachable(e);
  }
}
