import type { PortfolioSnapshot } from '@bpm/shared';
import { PortfolioView } from '@/components/PortfolioView';
import { backendFetch } from '@/lib/backend';

export const dynamic = 'force-dynamic';

async function load(): Promise<PortfolioSnapshot | null> {
  try {
    const res = await backendFetch('/api/portfolio');
    return res.ok ? ((await res.json()) as PortfolioSnapshot) : null;
  } catch {
    return null;
  }
}

export default async function Page() {
  return <PortfolioView initial={await load()} />;
}
