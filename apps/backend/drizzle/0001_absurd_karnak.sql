CREATE TABLE IF NOT EXISTS "alert_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset" text NOT NULL,
	"threshold_pct" double precision NOT NULL,
	"armed" boolean DEFAULT true NOT NULL,
	"watch_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset" text NOT NULL,
	"kind" text NOT NULL,
	"threshold_pct" double precision NOT NULL,
	"pnl_pct" double precision NOT NULL,
	"currency" text NOT NULL,
	"price_usd" double precision,
	"status" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alert_rules_asset_threshold" ON "alert_rules" USING btree ("asset","threshold_pct");