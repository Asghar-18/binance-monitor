CREATE TABLE IF NOT EXISTS "llm_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"asset" text,
	"model" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" text,
	"ok" boolean NOT NULL,
	"problems" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "analysis" jsonb;