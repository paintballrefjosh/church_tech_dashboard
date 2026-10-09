/**
 * Which app nodes run a different build from the rest. Used by the Monitoring page's per-node cards; the
 * Admin > Cluster page has its own (older) wording for the same condition.
 *
 * Only live nodes count: a node that stopped heartbeating keeps the build it last reported, which says nothing
 * about the cluster now. The reference is the build most live nodes run; the nodes on any other build are the
 * odd ones. With no clear majority (two nodes, two builds) there is no telling which side is right, so every
 * node of every differing build is odd.
 */
export interface NodeBuild {
  id: string;
  /** The build id the node reported (`BUILD_ID`); null when it did not report one. */
  version: string | null;
  live: boolean;
}

export interface BuildCheck {
  /** More than one build is running among the live nodes. */
  mismatch: boolean;
  /** The majority build, when there is one. */
  reference: string | null;
  /** Ids of the nodes to flag. Empty unless `mismatch`. */
  odd: ReadonlySet<string>;
  /** Live nodes grouped by build, biggest group first (for the explanation). */
  groups: ReadonlyArray<{ version: string; nodes: string[] }>;
}

const UNKNOWN = "unknown";

export function checkBuilds(nodes: readonly NodeBuild[]): BuildCheck {
  const by = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.live) continue;
    const v = n.version?.trim() || UNKNOWN;
    by.set(v, [...(by.get(v) ?? []), n.id]);
  }
  const groups = [...by.entries()]
    .map(([version, ids]) => ({ version, nodes: ids }))
    .sort((a, b) => b.nodes.length - a.nodes.length || a.version.localeCompare(b.version));
  if (groups.length <= 1) return { mismatch: false, reference: null, odd: new Set(), groups };
  const [first, second] = groups;
  const hasMajority = first!.nodes.length > second!.nodes.length;
  const odd = new Set<string>();
  for (const [i, g] of groups.entries()) {
    if (hasMajority && i === 0) continue;
    for (const id of g.nodes) odd.add(id);
  }
  return { mismatch: true, reference: hasMajority ? first!.version : null, odd, groups };
}
