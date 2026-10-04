-- API tokens: display prefix, read-only and module limits, revocation, last-used
-- IP, and the token id on audit rows. Existing tokens keep full access
-- (read_only defaults false, modules null = all); new tokens default to
-- read-only in the API. FK is a bare ALTER (no DO-block) for CockroachDB v24.2.
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "token_prefix" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "read_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "modules" text[];--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "last_used_ip" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "api_token_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_api_token_id_api_tokens_id_fk" FOREIGN KEY ("api_token_id") REFERENCES "api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_api_token_idx" ON "audit_log" USING btree ("api_token_id");
