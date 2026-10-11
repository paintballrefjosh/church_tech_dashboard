CREATE TABLE IF NOT EXISTS "availability_hourly" (
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"hour" timestamp NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"down" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "availability_hourly_kind_ref_hour_pk" PRIMARY KEY("kind","ref","hour")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "availability_hourly_hour_idx" ON "availability_hourly" USING btree ("hour");