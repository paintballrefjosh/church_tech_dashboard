import { Controller, Get, Post, Query, Inject } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { PERMISSIONS } from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { DB, type Db } from "../db/db.module";
import { groupMemberships } from "../db/schema";
import { SearchService, type SearchKind } from "./search.service";

const VALID_KINDS: SearchKind[] = [
  "ticket",
  "note",
  "wiki",
  "monitor",
  "infra_target",
  "infra_entity",
  "unifi_device",
  "unifi_client",
  "cisco_switch",
  "cisco_port",
  "cisco_mac",
  "cisco_arp",
  "cisco_vlan",
];

@Controller("search")
export class SearchController {
  constructor(
    private readonly search: SearchService,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Get()
  async query(
    @CurrentUser() user: AuthenticatedUser,
    @Query("q") q?: string,
    @Query("kind") kind?: string,
    @Query("limit") limit?: string,
  ) {
    if (!q || q.trim().length === 0) {
      return { hits: [] };
    }

    // Look up the user's group memberships so wiki ACL filtering works.
    // One round-trip per request — fine for the latency budget of a typeahead
    // (Meilisearch itself is ~10ms locally).
    const myGroups = await this.db
      .select({ id: groupMemberships.groupId })
      .from(groupMemberships)
      .where(eq(groupMemberships.userId, user.id));

    const kinds = kind
      ? (kind.split(",").filter((k) => (VALID_KINDS as string[]).includes(k)) as SearchKind[])
      : undefined;

    const hits = await this.search.search({
      q: q.trim(),
      userId: user.id,
      userGroupIds: myGroups.map((g) => g.id),
      canSeeAnyTicket: user.permissions.includes(PERMISSIONS.TICKETS_READ_ANY),
      canSeeAnyWiki: user.permissions.includes(PERMISSIONS.WIKI_READ_ANY),
      canSeeMonitoring: user.permissions.includes(PERMISSIONS.MONITORS_READ_ANY),
      canSeeUnifi: user.permissions.includes(PERMISSIONS.UNIFI_READ_ANY),
      kinds,
      limit: Math.max(1, Math.min(50, parseInt(limit ?? "20", 10) || 20)),
    });
    return { hits };
  }

  /**
   * Full reindex from the DB. Admin-only, kept synchronous: at this app's
   * scale a complete walk takes seconds, so we don't bother spawning a
   * background job. Returns per-kind counts so the UI can confirm.
   */
  @Post("reindex")
  @RequirePermissions(PERMISSIONS.SITE_ADMIN)
  @Audited({ action: "search.reindex", resourceType: "search" })
  async reindex() {
    const counts = await this.search.reindexAll();
    return { ok: true, counts };
  }
}
