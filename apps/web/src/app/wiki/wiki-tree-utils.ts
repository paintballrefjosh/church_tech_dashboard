import type { WikiTreeNode } from "@church/shared";

export interface WikiTreeUiNode {
  key: string;
  kind: "folder" | "page";
  id: string;
  label: string;
  children: WikiTreeUiNode[];
}

/** Merges the flat folders+pages list from GET /wiki/tree into a real tree. */
export function buildWikiTree(rows: WikiTreeNode[]): WikiTreeUiNode[] {
  const byKey = new Map<string, WikiTreeUiNode>();
  for (const r of rows) {
    const key = `${r.kind}:${r.id}`;
    byKey.set(key, {
      key,
      kind: r.kind,
      id: r.id,
      label: r.kind === "folder" ? r.name : r.title,
      children: [],
    });
  }
  const roots: WikiTreeUiNode[] = [];
  for (const r of rows) {
    const node = byKey.get(`${r.kind}:${r.id}`)!;
    const parentKey =
      r.kind === "page" && r.parentId
        ? `page:${r.parentId}`
        : r.parentFolderId
          ? `folder:${r.parentFolderId}`
          : null;
    if (parentKey && byKey.has(parentKey)) byKey.get(parentKey)!.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (nodes: WikiTreeUiNode[]) => {
    nodes.sort((a, b) =>
      a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "folder" ? -1 : 1,
    );
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);
  return roots;
}

export interface WikiBreadcrumb {
  kind: "folder" | "page";
  id: string;
  label: string;
}

/**
 * Ancestor chain (root-first, current page excluded) for breadcrumbs — walks
 * up through folders and/or parent pages, whichever the chain crosses. Not
 * React-specific, so it's also used from the (server-rendered) page view.
 */
export function ancestorChain(rows: WikiTreeNode[], pageId: string): WikiBreadcrumb[] {
  const byKey = new Map<
    string,
    { kind: "folder" | "page"; id: string; label: string; parentKey: string | null }
  >();
  for (const r of rows) {
    const key = `${r.kind}:${r.id}`;
    const parentKey =
      r.kind === "page" && r.parentId
        ? `page:${r.parentId}`
        : r.parentFolderId
          ? `folder:${r.parentFolderId}`
          : null;
    byKey.set(key, {
      kind: r.kind,
      id: r.id,
      label: r.kind === "folder" ? r.name : r.title,
      parentKey,
    });
  }
  const chain: WikiBreadcrumb[] = [];
  let cursor = byKey.get(`page:${pageId}`)?.parentKey ?? null;
  let depth = 0;
  const seen = new Set<string>();
  while (cursor && depth < 64 && !seen.has(cursor)) {
    seen.add(cursor);
    const node = byKey.get(cursor);
    if (!node) break;
    chain.unshift({ kind: node.kind, id: node.id, label: node.label });
    cursor = node.parentKey;
    depth++;
  }
  return chain;
}

export interface WikiTreeOption {
  key: string;
  kind: "folder" | "page";
  id: string;
  label: string;
  depth: number;
}

/**
 * Depth-first, indentable flat list for a <select>. `excludeKey` (e.g. the
 * page being edited) drops that node AND its whole subtree, so a page can't
 * be pointed at itself or one of its own descendants — belt-and-suspenders
 * alongside the server's cycle check.
 */
export function flattenWikiTree(
  nodes: WikiTreeUiNode[],
  depth = 0,
  excludeKey?: string,
): WikiTreeOption[] {
  const out: WikiTreeOption[] = [];
  for (const n of nodes) {
    if (n.key === excludeKey) continue;
    out.push({ key: n.key, kind: n.kind, id: n.id, label: n.label, depth });
    out.push(...flattenWikiTree(n.children, depth + 1, excludeKey));
  }
  return out;
}
