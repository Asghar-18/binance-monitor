/**
 * Pure cost-basis logic. No I/O, fully unit-tested.
 *
 * Method: weighted average cost.
 * - A buy adds its quantity (net of fees taken in the asset) and its full cost (including other fees).
 * - A sell removes quantity and removes cost in proportion, so the average price does not change.
 */
import type { EntrySource } from '@bpm/shared';

export interface Fill {
  time: number;
  asset: string;
  side: 'buy' | 'sell';
  qty: number;
  /** Buys only: total cost in USD including fees; null if the trade could not be priced */
  costUsd: number | null;
  /** Buys only: total cost in PKR at the trade-date rate */
  costPkr: number | null;
}

/** Row shape needed to derive fills (a subset of the trades table). */
export interface TradeLike {
  source: string;
  baseAsset: string;
  quoteAsset: string;
  isBuy: boolean;
  qty: number;
  quoteQty: number;
  commission: number;
  commissionAsset: string | null;
  time: number;
  quoteUsd: number | null;
  feeUsd: number;
  usdPkr: number | null;
}

export interface Basis {
  qty: number;
  costUsd: number;
  costPkr: number;
  avgUsd: number | null;
  avgPkr: number | null;
  /** Buys that could not be priced and were skipped */
  unpricedBuys: number;
}

const pkr = (usd: number | null, rate: number | null) => (usd !== null && rate !== null ? usd * rate : null);

/** Turn stored trades into per-asset fills. Stablecoins are skipped. */
export function buildFills(rows: TradeLike[], isStable: (asset: string) => boolean): Fill[] {
  const fills: Fill[] = [];
  const push = (f: Fill) => {
    if (!isStable(f.asset) && f.qty > 0) fills.push(f);
  };

  for (const r of rows) {
    if (r.source === 'convert') {
      // base = received, quote = given. quoteUsd = USD value of what was given.
      push({ time: r.time, asset: r.baseAsset, side: 'buy', qty: r.qty, costUsd: r.quoteUsd, costPkr: pkr(r.quoteUsd, r.usdPkr) });
      push({ time: r.time, asset: r.quoteAsset, side: 'sell', qty: r.quoteQty, costUsd: null, costPkr: null });
      continue;
    }

    const feeInBase = r.commissionAsset === r.baseAsset ? r.commission : 0;
    const feeInQuote = r.commissionAsset === r.quoteAsset ? r.commission : 0;

    if (r.isBuy) {
      // Bought base with quote. Fee in base reduces what arrived; any other fee adds to cost.
      const cost = r.quoteUsd === null ? null : r.quoteUsd + (feeInBase > 0 ? 0 : r.feeUsd);
      push({ time: r.time, asset: r.baseAsset, side: 'buy', qty: r.qty - feeInBase, costUsd: cost, costPkr: pkr(cost, r.usdPkr) });
      push({ time: r.time, asset: r.quoteAsset, side: 'sell', qty: r.quoteQty + feeInQuote, costUsd: null, costPkr: null });
    } else {
      // Sold base for quote. The quote asset received gets a cost basis equal to its USD value.
      push({ time: r.time, asset: r.baseAsset, side: 'sell', qty: r.qty + feeInBase, costUsd: null, costPkr: null });
      push({ time: r.time, asset: r.quoteAsset, side: 'buy', qty: r.quoteQty - feeInQuote, costUsd: r.quoteUsd, costPkr: pkr(r.quoteUsd, r.usdPkr) });
    }

    // A BNB fee on a pair that does not involve BNB spends BNB.
    if (r.commissionAsset && r.commission > 0 && r.commissionAsset !== r.baseAsset && r.commissionAsset !== r.quoteAsset) {
      push({ time: r.time, asset: r.commissionAsset, side: 'sell', qty: r.commission, costUsd: null, costPkr: null });
    }
  }
  return fills;
}

export function computeBasis(fills: Fill[]): Basis {
  const sorted = [...fills].sort((a, b) => a.time - b.time);
  let qty = 0;
  let costUsd = 0;
  let costPkr = 0;
  let pkrKnown = true;
  let unpricedBuys = 0;

  for (const f of sorted) {
    if (f.side === 'buy') {
      if (f.costUsd === null) {
        unpricedBuys++;
        continue;
      }
      qty += f.qty;
      costUsd += f.costUsd;
      if (f.costPkr === null) pkrKnown = false;
      else costPkr += f.costPkr;
    } else {
      if (qty <= 0) continue; // selling coins that arrived by deposit: nothing to reduce
      const sold = Math.min(f.qty, qty);
      const remaining = (qty - sold) / qty;
      qty -= sold;
      costUsd *= remaining;
      costPkr *= remaining;
      if (qty < 1e-12) {
        qty = 0;
        costUsd = 0;
        costPkr = 0;
      }
    }
  }

  return {
    qty,
    costUsd,
    costPkr,
    avgUsd: qty > 0 ? costUsd / qty : null,
    avgPkr: qty > 0 && pkrKnown ? costPkr / qty : null,
    unpricedBuys,
  };
}

export interface ResolvedEntry {
  source: EntrySource;
  avgUsd: number | null;
  avgPkr: number | null;
  coveragePct: number | null;
}

/** Choose the entry price to use for a holding: manual override, trade history, or unknown. */
export function resolveEntry(
  heldQty: number,
  basis: Basis | undefined,
  override: { avgUsd: number; avgPkr: number } | undefined,
): ResolvedEntry {
  if (override) return { source: 'manual', avgUsd: override.avgUsd, avgPkr: override.avgPkr, coveragePct: null };
  if (!basis || basis.qty <= 0 || basis.avgUsd === null || heldQty <= 0) {
    return { source: 'unknown', avgUsd: null, avgPkr: null, coveragePct: basis && heldQty > 0 ? 0 : null };
  }
  const coverage = Math.min(basis.qty / heldQty, 1) * 100;
  return {
    source: coverage >= 99 ? 'history' : 'partial',
    avgUsd: basis.avgUsd,
    avgPkr: basis.avgPkr,
    coveragePct: Math.round(coverage * 10) / 10,
  };
}
