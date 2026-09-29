import { backendFetch, relay, unreachable } from '@/lib/backend';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Ctx = { params: Promise<{ asset: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  const { asset } = await params;
  try {
    return await relay(await backendFetch(`/api/holdings/${encodeURIComponent(asset)}/analysis`, { method: 'POST' }, 55_000));
  } catch (e) {
    return unreachable(e);
  }
}
