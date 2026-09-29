import {
  bigint,
  boolean,
  doublePrecision,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Every fill that affects cost basis.
 * - source 'spot': one row per Binance trade. base/quote are the pair's assets.
 * - source 'convert': one row per Convert order. base = asset received, quote = asset given.
 */
export const trades = pgTable(
  'trades',
  {
    id: serial('id').primaryKey(),
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    symbol: text('symbol').notNull(),
    baseAsset: text('base_asset').notNull(),
    quoteAsset: text('quote_asset').notNull(),
    isBuy: boolean('is_buy').notNull(),
    qty: doublePrecision('qty').notNull(),
    quoteQty: doublePrecision('quote_qty').notNull(),
    price: doublePrecision('price').notNull(),
    commission: doublePrecision('commission').notNull().default(0),
    commissionAsset: text('commission_asset'),
    time: bigint('time', { mode: 'number' }).notNull(),
    /** USD value of quoteQty at trade time; null if it could not be priced */
    quoteUsd: doublePrecision('quote_usd'),
    /** USD value of the commission when it was not paid in the base asset */
    feeUsd: doublePrecision('fee_usd').notNull().default(0),
    /** USD/PKR rate for the trade date */
    usdPkr: doublePrecision('usd_pkr'),
  },
  (t) => ({
    uniq: uniqueIndex('trades_source_symbol_ext').on(t.source, t.symbol, t.externalId),
  }),
);

export const syncState = pgTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const entryOverrides = pgTable('entry_overrides', {
  asset: text('asset').primaryKey(),
  avgUsd: doublePrecision('avg_usd').notNull(),
  avgPkr: doublePrecision('avg_pkr').notNull(),
  /** Currency the user typed the price in */
  inputCurrency: text('input_currency').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const fxRates = pgTable('fx_rates', {
  /** YYYY-MM-DD */
  date: text('date').primaryKey(),
  usdPkr: doublePrecision('usd_pkr').notNull(),
});

export type TradeRow = typeof trades.$inferSelect;
export type NewTradeRow = typeof trades.$inferInsert;

/** One row per threshold per coin. */
export const alertRules = pgTable(
  'alert_rules',
  {
    id: serial('id').primaryKey(),
    asset: text('asset').notNull(),
    thresholdPct: doublePrecision('threshold_pct').notNull(),
    armed: boolean('armed').notNull().default(true),
    /** An "approaching" alert was already sent for the current approach */
    watchSent: boolean('watch_sent').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('alert_rules_asset_threshold').on(t.asset, t.thresholdPct),
  }),
);

/** Every alert the engine produced, whether or not it was delivered. */
export const alerts = pgTable('alerts', {
  id: serial('id').primaryKey(),
  asset: text('asset').notNull(),
  kind: text('kind').notNull(),
  thresholdPct: doublePrecision('threshold_pct').notNull(),
  pnlPct: doublePrecision('pnl_pct').notNull(),
  currency: text('currency').notNull(),
  priceUsd: doublePrecision('price_usd'),
  status: text('status').notNull(),
  message: text('message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AlertRuleRow = typeof alertRules.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
