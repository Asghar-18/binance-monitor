import { describe, expect, it } from 'vitest';
import { buildFills, computeBasis, resolveEntry, TradeLike } from './cost-basis';

const stable = (a: string) => ['USDT', 'FDUSD', 'USDC'].includes(a);

const trade = (t: Partial<TradeLike>): TradeLike => ({
  source: 'spot',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  isBuy: true,
  qty: 0,
  quoteQty: 0,
  commission: 0,
  commissionAsset: null,
  time: 0,
  quoteUsd: null,
  feeUsd: 0,
  usdPkr: 280,
  ...t,
});

const basisFor = (asset: string, rows: TradeLike[]) =>
  computeBasis(buildFills(rows, stable).filter((f) => f.asset === asset));

describe('weighted average cost', () => {
  it('averages two buys', () => {
    const b = basisFor('BTC', [
      trade({ time: 1, qty: 1, quoteQty: 100_000, quoteUsd: 100_000 }),
      trade({ time: 2, qty: 1, quoteQty: 110_000, quoteUsd: 110_000 }),
    ]);
    expect(b.qty).toBe(2);
    expect(b.avgUsd).toBe(105_000);
    expect(b.avgPkr).toBe(105_000 * 280);
  });

  it('keeps the average unchanged after a partial sell', () => {
    const b = basisFor('BTC', [
      trade({ time: 1, qty: 2, quoteQty: 200_000, quoteUsd: 200_000 }),
      trade({ time: 2, isBuy: false, qty: 0.5, quoteQty: 60_000, quoteUsd: 60_000 }),
    ]);
    expect(b.qty).toBeCloseTo(1.5);
    expect(b.avgUsd).toBeCloseTo(100_000);
  });

  it('resets after selling everything, then starts fresh', () => {
    const b = basisFor('BTC', [
      trade({ time: 1, qty: 1, quoteQty: 50_000, quoteUsd: 50_000 }),
      trade({ time: 2, isBuy: false, qty: 1, quoteQty: 60_000, quoteUsd: 60_000 }),
      trade({ time: 3, qty: 1, quoteQty: 90_000, quoteUsd: 90_000 }),
    ]);
    expect(b.qty).toBe(1);
    expect(b.avgUsd).toBe(90_000);
  });

  it('uses the trade-date PKR rate for each buy', () => {
    const b = basisFor('BTC', [
      trade({ time: 1, qty: 1, quoteQty: 100, quoteUsd: 100, usdPkr: 280 }),
      trade({ time: 2, qty: 1, quoteQty: 100, quoteUsd: 100, usdPkr: 300 }),
    ]);
    expect(b.avgUsd).toBe(100);
    expect(b.avgPkr).toBe(29_000);
  });
});

describe('fees', () => {
  it('fee in the bought asset reduces quantity, not cost', () => {
    const b = basisFor('BTC', [
      trade({ qty: 1, quoteQty: 100_000, quoteUsd: 100_000, commission: 0.001, commissionAsset: 'BTC' }),
    ]);
    expect(b.qty).toBeCloseTo(0.999);
    expect(b.costUsd).toBe(100_000);
  });

  it('BNB fee adds to cost and spends BNB', () => {
    const rows = [
      trade({ time: 1, baseAsset: 'BNB', qty: 10, quoteQty: 6000, quoteUsd: 6000 }),
      trade({ time: 2, qty: 1, quoteQty: 100_000, quoteUsd: 100_000, commission: 0.1, commissionAsset: 'BNB', feeUsd: 60 }),
    ];
    expect(basisFor('BTC', rows).costUsd).toBe(100_060);
    expect(basisFor('BNB', rows).qty).toBeCloseTo(9.9);
    expect(basisFor('BNB', rows).avgUsd).toBeCloseTo(600);
  });
});

describe('non-USD quotes and Convert', () => {
  it('ETHBTC buy gives ETH a basis and spends BTC', () => {
    const rows = [
      trade({ time: 1, qty: 1, quoteQty: 100_000, quoteUsd: 100_000 }),
      trade({ time: 2, baseAsset: 'ETH', quoteAsset: 'BTC', qty: 10, quoteQty: 0.4, quoteUsd: 40_000 }),
    ];
    expect(basisFor('ETH', rows).avgUsd).toBe(4000);
    expect(basisFor('BTC', rows).qty).toBeCloseTo(0.6);
    expect(basisFor('BTC', rows).avgUsd).toBeCloseTo(100_000);
  });

  it('Convert from USDT to SOL is a buy of SOL', () => {
    const b = basisFor('SOL', [
      trade({ source: 'convert', baseAsset: 'SOL', quoteAsset: 'USDT', qty: 5, quoteQty: 1000, quoteUsd: 1000 }),
    ]);
    expect(b.avgUsd).toBe(200);
  });

  it('skips unpriced buys and counts them', () => {
    const b = basisFor('BTC', [trade({ qty: 1, quoteQty: 1, quoteUsd: null })]);
    expect(b.qty).toBe(0);
    expect(b.unpricedBuys).toBe(1);
  });
});

describe('resolveEntry', () => {
  const basis = computeBasis([{ time: 1, asset: 'BTC', side: 'buy', qty: 1, costUsd: 100, costPkr: 28_000 }]);

  it('manual override wins', () => {
    expect(resolveEntry(1, basis, { avgUsd: 90, avgPkr: 25_000 }).source).toBe('manual');
  });

  it('full coverage is history', () => {
    expect(resolveEntry(1, basis, undefined)).toMatchObject({ source: 'history', avgUsd: 100, coveragePct: 100 });
  });

  it('half the coins from deposits is partial', () => {
    expect(resolveEntry(2, basis, undefined)).toMatchObject({ source: 'partial', coveragePct: 50 });
  });

  it('no history is unknown', () => {
    expect(resolveEntry(1, undefined, undefined).source).toBe('unknown');
  });
});
