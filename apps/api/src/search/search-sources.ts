import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  tickets,
  notes,
  wikiPages,
  wikiPageAcl,
  monitors,
  infraTargets,
  infraEntities,
  ciscoSwitches,
  ciscoPorts,
  ciscoMacTable,
  ciscoArpCache,
  ciscoVlanDb,
  ipamSubnets,
  ipamHosts,
} from "../db/schema";
import { searchDocId, type ContentKind, type SearchDoc } from "./search-types";

/**
 * Where the search service gets the documents it indexes from. Everything the
 * index holds is derived from one of these (or from `live_search_docs`), so any
 * node can rebuild its whole index, and a change to one resource is applied by
 * re-reading that resource, never by trusting a payload from another node.
 */
export interface SearchSources {
  /** The document for one ticket, note or wiki page, or null if it no longer exists. */
  loadContentDoc(kind: ContentKind, id: string): Promise<SearchDoc | null>;
  /** Every document of one content kind. */
  loadContentDocs(kind: ContentKind): Promise<SearchDoc[]>;
  /** Every DB-backed monitoring document (monitors, infra, Cisco, IPAM). */
  loadMonitoringDocs(): Promise<SearchDoc[]>;
}

export const SEARCH_SOURCES = Symbol("SEARCH_SOURCES");

export function ticketDoc(row: typeof tickets.$inferSelect): SearchDoc {
  return {
    id: searchDocId("ticket", row.id),
    kind: "ticket",
    resourceId: row.id,
    ownerUserId: row.createdByUserId,
    title: row.title,
    body: row.description ?? "",
    extra: { number: row.number, status: row.status, priority: row.priority },
    url: `/tickets/${row.id}`,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function noteDoc(row: typeof notes.$inferSelect): SearchDoc {
  return {
    id: searchDocId("note", row.id),
    kind: "note",
    resourceId: row.id,
    ownerUserId: row.ownerUserId,
    title: row.title || "(untitled)",
    body: row.body,
    extra: { color: row.color, pinned: row.pinned, archived: row.archived },
    url: `/notes`,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Wiki pages carry their ACL group ids so the search-time filter can scope them. */
export function wikiDoc(row: typeof wikiPages.$inferSelect, aclGroupIds: string[]): SearchDoc {
  return {
    id: searchDocId("wiki", row.id),
    kind: "wiki",
    resourceId: row.id,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility as "public" | "group",
    aclGroupIds: row.visibility === "group" ? aclGroupIds : [],
    title: row.title,
    body: row.body ?? "",
    url: `/wiki/${row.id}`,
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class DbSearchSources implements SearchSources {
  constructor(@Inject(DB) private readonly db: Db) {}

  async loadContentDoc(kind: ContentKind, id: string): Promise<SearchDoc | null> {
    if (kind === "ticket") {
      const [row] = await this.db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
      return row ? ticketDoc(row) : null;
    }
    if (kind === "note") {
      const [row] = await this.db.select().from(notes).where(eq(notes.id, id)).limit(1);
      return row ? noteDoc(row) : null;
    }
    const [row] = await this.db.select().from(wikiPages).where(eq(wikiPages.id, id)).limit(1);
    if (!row) return null;
    const acl =
      row.visibility === "group"
        ? await this.db.select({ groupId: wikiPageAcl.groupId }).from(wikiPageAcl).where(eq(wikiPageAcl.pageId, id))
        : [];
    return wikiDoc(row, acl.map((a) => a.groupId));
  }

  async loadContentDocs(kind: ContentKind): Promise<SearchDoc[]> {
    if (kind === "ticket") {
      return (await this.db.select().from(tickets).orderBy(asc(tickets.id))).map(ticketDoc);
    }
    if (kind === "note") {
      return (await this.db.select().from(notes).orderBy(asc(notes.id))).map(noteDoc);
    }
    const [pageRows, aclRows] = await Promise.all([
      this.db.select().from(wikiPages).orderBy(asc(wikiPages.id)),
      this.db.select().from(wikiPageAcl),
    ]);
    const aclByPage = new Map<string, string[]>();
    for (const a of aclRows) {
      const cur = aclByPage.get(a.pageId) ?? [];
      cur.push(a.groupId);
      aclByPage.set(a.pageId, cur);
    }
    return pageRows.map((row) => wikiDoc(row, aclByPage.get(row.id) ?? []));
  }

  async loadMonitoringDocs(): Promise<SearchDoc[]> {
    return this.buildMonitoringDbDocs();
  }

  /** Timestamp helper — cache tables (cisco) carry no updatedAt, so freshness
   * is "now" each sync; DB entities use their own updatedAt where present. */
  private nowIso(): string {
    return new Date().toISOString();
  }

  /**
   * Build the searchable documents for every DB-backed monitoring source:
   * service monitors, infra targets + present entities, and the Cisco caches
   * (switches, ports, MAC table, ARP cache, VLAN DB). UniFi lives outside the
   * DB and is handled by `syncUnifi`.
   */
  private async buildMonitoringDbDocs(): Promise<SearchDoc[]> {
    const [monRows, targetRows, entityRows, switchRows, portRows, macRows, arpRows, vlanRows, ipamSubnetRows, ipamHostRows] =
      await Promise.all([
        this.db.select().from(monitors),
        this.db.select().from(infraTargets),
        this.db.select().from(infraEntities).where(eq(infraEntities.present, true)),
        this.db.select().from(ciscoSwitches),
        this.db.select().from(ciscoPorts),
        this.db.select().from(ciscoMacTable),
        this.db.select().from(ciscoArpCache),
        this.db.select().from(ciscoVlanDb),
        this.db.select().from(ipamSubnets),
        this.db.select().from(ipamHosts),
      ]);

    const swName = new Map(switchRows.map((s) => [s.id, s.hostname]));
    const now = this.nowIso();
    const docs: SearchDoc[] = [];

    for (const r of monRows) {
      docs.push({
        id: searchDocId("monitor", r.id),
        kind: "monitor",
        resourceId: r.id,
        ownerUserId: null,
        title: r.name,
        body: r.target,
        extra: { kind: r.kind, status: r.status },
        url: `/monitoring/${r.id}`,
        updatedAt: r.updatedAt.toISOString(),
      });
    }

    for (const r of targetRows) {
      docs.push({
        id: searchDocId("infra_target", r.id),
        kind: "infra_target",
        resourceId: r.id,
        ownerUserId: null,
        title: r.name,
        body: [r.host, r.kind, r.os].filter(Boolean).join(" · "),
        extra: { status: r.status, kind: r.kind },
        url: `/monitoring/infra/${r.id}`,
        updatedAt: r.updatedAt.toISOString(),
      });
    }

    for (const r of entityRows) {
      docs.push({
        id: searchDocId("infra_entity", r.id),
        kind: "infra_entity",
        resourceId: r.id,
        ownerUserId: null,
        title: r.name,
        body: [r.entityKind, r.groupKey, r.status].filter(Boolean).join(" · "),
        extra: { entityKind: r.entityKind, status: r.status, targetId: r.targetId },
        // Entities live under their parent target's detail page.
        url: `/monitoring/infra/${r.targetId}`,
        updatedAt: r.lastSeenAt.toISOString(),
      });
    }

    for (const r of switchRows) {
      docs.push({
        id: searchDocId("cisco_switch", r.id),
        kind: "cisco_switch",
        resourceId: r.id,
        ownerUserId: null,
        title: r.hostname,
        body: [r.ipAddress, r.model, r.location].filter(Boolean).join(" · "),
        extra: { reachable: r.reachable, model: r.model },
        url: `/monitoring/network-cisco/switches/${r.id}`,
        updatedAt: now,
      });
    }

    for (const r of portRows) {
      const host = swName.get(r.switchId) ?? "";
      docs.push({
        id: searchDocId("cisco_port", r.id),
        kind: "cisco_port",
        resourceId: r.id,
        ownerUserId: null,
        title: [host, r.portId].filter(Boolean).join(" "),
        body: [r.description, `vlan ${r.accessVlan}`, r.neighborHostname].filter(Boolean).join(" · "),
        extra: { switchId: r.switchId, portId: r.portId },
        url: `/monitoring/network-cisco/switches/${r.switchId}`,
        updatedAt: now,
      });
    }

    for (const r of macRows) {
      const host = swName.get(r.switchId) ?? "";
      docs.push({
        id: searchDocId("cisco_mac", r.id),
        kind: "cisco_mac",
        resourceId: r.id,
        ownerUserId: null,
        title: r.macAddress,
        body: [`vlan ${r.vlan ?? "?"}`, r.portId, host].filter(Boolean).join(" · "),
        extra: { switchId: r.switchId, vlan: r.vlan },
        url: `/monitoring/network-cisco/lookup`,
        updatedAt: now,
      });
    }

    for (const r of arpRows) {
      const host = swName.get(r.switchId) ?? "";
      docs.push({
        id: searchDocId("cisco_arp", r.id),
        kind: "cisco_arp",
        resourceId: r.id,
        ownerUserId: null,
        title: r.ipAddress,
        body: [r.macAddress, r.rdnsName, r.interface, host].filter(Boolean).join(" · "),
        extra: { switchId: r.switchId, mac: r.macAddress },
        url: `/monitoring/network-cisco/lookup`,
        updatedAt: now,
      });
    }

    for (const r of vlanRows) {
      const host = swName.get(r.switchId) ?? "";
      docs.push({
        id: searchDocId("cisco_vlan", r.id),
        kind: "cisco_vlan",
        resourceId: r.id,
        ownerUserId: null,
        title: [`VLAN ${r.vlanId}`, r.vlanName].filter(Boolean).join(" "),
        body: [r.vlanStatus, host].filter(Boolean).join(" · "),
        extra: { switchId: r.switchId, vlanId: r.vlanId },
        url: `/monitoring/network-cisco/vlans`,
        updatedAt: now,
      });
    }

    for (const r of ipamSubnetRows) {
      docs.push({
        id: searchDocId("ipam_subnet", r.id),
        kind: "ipam_subnet",
        resourceId: r.id,
        ownerUserId: null,
        title: [r.cidr, r.label].filter(Boolean).join(" · "),
        body: [r.label, r.gateway, r.vlanId ? `vlan ${r.vlanId}` : null, r.source].filter(Boolean).join(" · "),
        extra: { source: r.source, scanEnabled: r.scanEnabled },
        url: `/ipam/${r.id}`,
        updatedAt: r.updatedAt.toISOString(),
      });
    }

    for (const r of ipamHostRows) {
      docs.push({
        id: searchDocId("ipam_host", r.id),
        kind: "ipam_host",
        resourceId: r.id,
        ownerUserId: null,
        title: [r.ipAddress, r.unifiName].filter(Boolean).join(" · "),
        body: [r.unifiName, r.hostname, r.netbiosName, r.macAddress].filter(Boolean).join(" · "),
        extra: { subnetId: r.subnetId, isUp: r.isUp },
        url: `/ipam/${r.subnetId}`,
        updatedAt: r.updatedAt.toISOString(),
      });
    }

    return docs;
  }
}
