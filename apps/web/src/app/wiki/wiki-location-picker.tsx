"use client";

import { useEffect, useState } from "react";
import type { WikiTreeNode } from "@church/shared";
import { buildWikiTree, flattenWikiTree } from "./wiki-tree-utils";

export interface WikiLocation {
  parentId: string | null;
  parentFolderId: string | null;
}

/**
 * "Where does this page live?" — root, inside a folder, or as a subpage of
 * another page. Encodes the choice as a single <select> value (`folder:<id>`
 * / `page:<id>` / "" for root) since the two are mutually exclusive on the
 * wiki_pages row.
 */
export function WikiLocationPicker({
  value,
  onChange,
  excludePageId,
  label = "Location",
}: {
  value: WikiLocation;
  onChange: (v: WikiLocation) => void;
  /** When editing, exclude this page (and its subtree) so it can't become its own descendant. */
  excludePageId?: string;
  label?: string;
}) {
  const [tree, setTree] = useState<WikiTreeNode[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await fetch("/api/wiki/tree", { credentials: "same-origin", cache: "no-store" });
      if (!r.ok || cancelled) return;
      setTree((await r.json()) as WikiTreeNode[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const options = flattenWikiTree(
    buildWikiTree(tree),
    0,
    excludePageId ? `page:${excludePageId}` : undefined,
  );

  const selected = value.parentFolderId
    ? `folder:${value.parentFolderId}`
    : value.parentId
      ? `page:${value.parentId}`
      : "";

  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
      <select
        value={selected}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) onChange({ parentId: null, parentFolderId: null });
          else if (v.startsWith("folder:")) {
            onChange({ parentId: null, parentFolderId: v.slice("folder:".length) });
          } else {
            onChange({ parentId: v.slice("page:".length), parentFolderId: null });
          }
        }}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
      >
        <option value="">— Root (top level) —</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {"  ".repeat(o.depth)}
            {o.depth > 0 ? "– " : ""}
            {o.label}
            {o.kind === "folder" ? " (folder)" : ""}
          </option>
        ))}
      </select>
      <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
        File it under a folder, or make it a subpage of another page.
      </span>
    </label>
  );
}
