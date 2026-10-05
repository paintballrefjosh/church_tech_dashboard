CREATE TABLE IF NOT EXISTS "live_snapshots" (
	"kind" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "realtime_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"origin_node" text NOT NULL,
	"seq" bigint NOT NULL,
	"room" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb,
	"ref" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "realtime_presence" (
	"node_id" text NOT NULL,
	"room" text NOT NULL,
	"sockets" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "realtime_presence_node_id_room_pk" PRIMARY KEY("node_id","room")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_outbox_due_idx" ON "mail_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "realtime_events_ts_idx" ON "realtime_events" USING btree ("ts");