import { backendFetch, relay, unreachable } from '@/lib/backend';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST() {
  try {
    return await relay(await backendFetch('/api/digest/send', { method: 'POST' }, 55_000));
  } catch (e) {
    return unreachable(e);
  }
}
