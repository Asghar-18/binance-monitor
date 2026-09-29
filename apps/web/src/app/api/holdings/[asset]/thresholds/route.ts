import { backendFetch, relay, unreachable } from '@/lib/backend';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ asset: string }> };

export async function PUT(req: Request, { params }: Ctx) {
  const { asset } = await params;
  try {
    const body = await req.text();
    return await relay(await backendFetch(`/api/holdings/${encodeURIComponent(asset)}/thresholds`, { method: 'PUT', body }));
  } catch (e) {
    return unreachable(e);
  }
}
