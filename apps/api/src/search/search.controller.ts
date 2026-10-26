import { Controller, Get, Post, Query } from "@nestjs/common";
import { PERMISSIONS } from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { SearchService, type SearchKind } from "./search.service";

/** Every kind the search endpoint accepts in `kind` (also the MCP search tool's choices). */
export const SEARCH_KINDS: SearchKind[] = [
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
  "ipam_subnet",
  "ipam_host",
  "service_instance",
  "dns_record",
  "asset",
];

@Controller("search")
export class SearchController {
  constructor(private readonly search: SearchService) {}

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

    const kinds = kind
      ? (kind.split(",").filter((k) => (SEARCH_KINDS as string[]).includes(k)) as SearchKind[])
      : undefined;

    const hits = await this.search.search({
      q: q.trim(),
      userId: user.id,
      // Group ids come with the cached user (dropped on every membership change), so wiki ACL filtering costs
      // no query here: this runs on every keystroke that survives the debounce.
      userGroupIds: user.groupIds,
      canSeeAnyTicket: user.permissions.includes(PERMISSIONS.TICKETS_READ_ANY),
      canSeeAnyWiki: user.permissions.includes(PERMISSIONS.WIKI_READ_ANY),
      canSeeMonitoring: user.permissions.includes(PERMISSIONS.MONITORS_READ_ANY),
      canSeeUnifi: user.permissions.includes(PERMISSIONS.UNIFI_READ_ANY),
      canSeeAssets: user.permissions.includes(PERMISSIONS.ASSETS_READ_ANY),
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
    const counts = await this.search.reindexEverywhere();
    return { ok: true, counts };
  }
}
