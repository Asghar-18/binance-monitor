CREATE TABLE IF NOT EXISTS "entry_overrides" (
	"asset" text PRIMARY KEY NOT NULL,
	"avg_usd" double precision NOT NULL,
	"avg_pkr" double precision NOT NULL,
	"input_currency" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fx_rates" (
	"date" text PRIMARY KEY NOT NULL,
	"usd_pkr" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"symbol" text NOT NULL,
	"base_asset" text NOT NULL,
	"quote_asset" text NOT NULL,
	"is_buy" boolean NOT NULL,
	"qty" double precision NOT NULL,
	"quote_qty" double precision NOT NULL,
	"price" double precision NOT NULL,
	"commission" double precision DEFAULT 0 NOT NULL,
	"commission_asset" text,
	"time" bigint NOT NULL,
	"quote_usd" double precision,
	"fee_usd" double precision DEFAULT 0 NOT NULL,
	"usd_pkr" double precision
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trades_source_symbol_ext" ON "trades" USING btree ("source","symbol","external_id");