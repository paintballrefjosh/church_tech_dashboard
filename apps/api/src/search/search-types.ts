// Shared shapes for the search index. Re-exported from search.service.ts.

/**
 * Type discriminator stamped on every indexed document. Drives the result
 * label/colour on the frontend.
 */
export type SearchKind =
  | "ticket"
  | "note"
  | "wiki"
  | "monitor"
  | "infra_target"
  | "infra_entity"
  | "unifi_device"
  | "unifi_client"
  | "cisco_switch"
  | "cisco_port"
  | "cisco_mac"
  | "cisco_arp"
  | "cisco_vlan"
  | "ipam_subnet"
  | "ipam_host"
  | "dns_record";

/**
 * Monitoring kinds visible to anyone with `monitors:read:any` (the `monitoring`
 * module read tier). UniFi kinds ride `unifi:read:any` separately — see
 * UNIFI_KINDS. Cisco reads also gate on `monitors:read:any` per the module doc.
 */
export const MONITORING_KINDS: SearchKind[] = [
  "monitor",
  "infra_target",
  "infra_entity",
  "cisco_switch",
  "cisco_port",
  "cisco_mac",
  "cisco_arp",
  "cisco_vlan",
  "ipam_subnet",
  "ipam_host",
];
export const UNIFI_KINDS: SearchKind[] = ["unifi_device", "unifi_client"];
/**
 * DNS records live in Technitium, not the DB, so they're kept out of
 * MONITORING_KINDS (whose periodic sync clears and rebuilds from the DB) and
 * pushed by the DNS module's indexer instead. Same monitors:read:any gate.
 */
export const DNS_KINDS: SearchKind[] = ["dns_record"];

/**
 * Build a Meilisearch document id from a kind + resource id.
 *
 * Meilisearch primary keys are restricted to alphanumerics, hyphens, and
 * underscores — a colon is rejected and the whole document-addition task fails
 * asynchronously (never surfaced to the enqueuing call). Join with `_` so the
 * id stays valid; resource UUIDs already contain hyphens, which are allowed.
 * The raw resource id is stored separately in `resourceId` for deep links.
 */
export function searchDocId(kind: SearchKind, resourceId: string): string {
  // Meilisearch primary keys allow only [A-Za-z0-9_-]; UUIDs already qualify,
  // but MAC-address-keyed docs (UniFi devices/clients) contain colons, so
  // sanitise. The raw value is preserved separately in `resourceId`.
  const safe = resourceId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${kind}_${safe}`;
}

export interface SearchDoc {
  /** "<kind>:<resourceId>" — stable across edits so an update overwrites in place. */
  id: string;
  kind: SearchKind;
  /** Resource UUID/key — what the UI uses to build a deep link. */
  resourceId: string;
  ownerUserId?: string | null;
  visibility?: "public" | "group" | "private" | null;
  /** Permission-bearing ACL — wiki pages store group ids here. Empty for everyone-readable. */
  aclGroupIds?: string[];
  title: string;
  body: string;
  tagIds?: string[];
  /** Free-form extra fields the frontend can render (e.g. ticket number, note color). */
  extra?: Record<string, unknown>;
  /**
   * Deep link for this result. Set at index time so kinds whose link target
   * differs from `resourceId` (e.g. an infra entity links to its parent target,
   * a Cisco MAC links to the lookup page) route correctly without the frontend
   * hard-coding every case.
   */
  url?: string;
  /** Document timestamp; we sort by recency as a secondary signal. */
  updatedAt: string;
  /**
   * Hash of the document's content (see docRev), stamped when it is indexed. A
   * reconcile compares it to the desired document's to find what changed
   * without rewriting the rest. Not meaningful to the UI.
   */
  rev?: string;
}

export interface SearchResult extends SearchDoc {
  _formatted?: Partial<SearchDoc>;
}


/** Kinds whose source of truth is this database, kept in step by change events. */
export type ContentKind = "ticket" | "note" | "wiki";
export const CONTENT_KINDS: ContentKind[] = ["ticket", "note", "wiki"];

/**
 * Kinds that come from outside the database (the UniFi controller, the DNS
 * server). One node reads them and writes the current set to
 * `live_search_docs`; every node reconciles its index from that table.
 */
export const LIVE_KINDS: SearchKind[] = [...UNIFI_KINDS, ...DNS_KINDS];
