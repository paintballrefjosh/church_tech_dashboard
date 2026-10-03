-- Indexes added to support the perf review hotpath findings.
--
-- group_memberships(user_id): the PK leads with group_id, so every
--   loadUserById call (runs on every authenticated request) would scan to
--   resolve a user's groups. This is the hottest join in the API.
--
-- wiki_page_acl(group_id): PK leads with page_id; the wiki list and search
--   ACL filter both lookup "pages reachable by this user's groups", which
--   would scan without a secondary index.
--
-- tickets(created_by_user_id, updated_at DESC): owner-scoped ticket list
--   filters by creator then orders by recency; composite removes the sort.
--
-- notes(owner_user_id, archived, updated_at DESC): every note list filters
--   on owner + archived flag then orders by recency.
--
-- Safe to apply against an existing snapshot: all CREATE INDEX IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS "group_memberships_user_idx" ON "group_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_page_acl_group_idx" ON "wiki_page_acl" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tickets_owner_updated_idx" ON "tickets" USING btree ("created_by_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notes_owner_archived_updated_idx" ON "notes" USING btree ("owner_user_id","archived","updated_at" DESC NULLS LAST);
