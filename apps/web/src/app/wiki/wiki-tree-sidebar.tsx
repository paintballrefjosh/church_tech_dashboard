"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown, Folder, FolderPlus, Plus, Pencil, Trash2 } from "lucide-react";
import type { WikiTreeNode } from "@church/shared";
import { buildWikiTree, type WikiTreeUiNode as Node } from "./wiki-tree-utils";

/**
 * Sidebar rendering the merged wiki tree: folders (pure containers) and pages
 * (which can also nest under one another as subpages) in one hierarchy. A
 * page whose parent isn't readable by this user (ACL) naturally floats to
 * root, same as before — folders themselves have no ACL, so they always show.
 */
export function WikiTreeSidebar({
  tree,
  activeId,
}: {
  tree: WikiTreeNode[];
  activeId?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const roots = useMemo(() => buildWikiTree(tree), [tree]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function createFolder(parentFolderId: string | null) {
    const name = prompt("Folder name")?.trim();
    if (!name) return;
    setBusy(true);
    const res = await fetch("/api/wiki/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, parentFolderId }),
      credentials: "same-origin",
    });
    setBusy(false);
    if (res.ok) router.refresh();
    else alert(`Couldn't create folder (${res.status})`);
  }

  async function renameFolder(id: string, current: string) {
    const name = prompt("Rename folder", current)?.trim();
    if (!name || name === current) return;
    setBusy(true);
    const res = await fetch(`/api/wiki/folders/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      credentials: "same-origin",
    });
    setBusy(false);
    if (res.ok) router.refresh();
    else alert(`Couldn't rename folder (${res.status})`);
  }

  async function deleteFolder(id: string, label: string) {
    if (!confirm(`Delete folder "${label}"? Pages and sub-folders inside it move to the root — nothing is deleted.`)) {
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/wiki/folders/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    setBusy(false);
    if (res.ok) router.refresh();
    else alert(`Couldn't delete folder (${res.status})`);
  }

  if (roots.length === 0) {
    return (
      <nav className="text-sm" aria-label="Wiki page tree">
        <SidebarHeader busy={busy} onNewFolder={() => void createFolder(null)} />
        <p className="text-xs text-slate-500 dark:text-slate-400">No pages yet.</p>
      </nav>
    );
  }

  return (
    <nav className="text-sm" aria-label="Wiki page tree">
      <SidebarHeader busy={busy} onNewFolder={() => void createFolder(null)} />
      <TreeList
        nodes={roots}
        activeId={activeId}
        depth={0}
        collapsed={collapsed}
        onToggle={toggle}
        onNewPage={(parentFolderId, parentId) => {
          const qs = new URLSearchParams();
          if (parentFolderId) qs.set("parentFolderId", parentFolderId);
          if (parentId) qs.set("parentId", parentId);
          router.push(`/wiki/new?${qs.toString()}`);
        }}
        onNewFolder={(parentFolderId) => void createFolder(parentFolderId)}
        onRenameFolder={(id, label) => void renameFolder(id, label)}
        onDeleteFolder={(id, label) => void deleteFolder(id, label)}
      />
    </nav>
  );
}

function SidebarHeader({ busy, onNewFolder }: { busy: boolean; onNewFolder: () => void }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        All pages
      </h2>
      <button
        type="button"
        disabled={busy}
        onClick={onNewFolder}
        title="New folder"
        className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-60 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
      >
        <FolderPlus className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

function TreeList({
  nodes,
  activeId,
  depth,
  collapsed,
  onToggle,
  onNewPage,
  onNewFolder,
  onRenameFolder,
  onDeleteFolder,
}: {
  nodes: Node[];
  activeId?: string;
  depth: number;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  onNewPage: (parentFolderId: string | null, parentId: string | null) => void;
  onNewFolder: (parentFolderId: string) => void;
  onRenameFolder: (id: string, label: string) => void;
  onDeleteFolder: (id: string, label: string) => void;
}) {
  return (
    <ul
      className={
        depth === 0
          ? "space-y-0.5"
          : "ml-3 mt-0.5 space-y-0.5 border-l border-slate-300 pl-2 dark:border-slate-700"
      }
    >
      {nodes.map((n) => {
        const isOpen = !collapsed.has(n.key);
        return (
          <li key={n.key} className="group">
            {n.kind === "folder" ? (
              <div className="flex items-start gap-1 rounded px-1 py-0.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                <button
                  type="button"
                  onClick={() => onToggle(n.key)}
                  className="mt-0.5 shrink-0 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                  aria-label={isOpen ? "Collapse" : "Expand"}
                >
                  {n.children.length > 0 ? (
                    isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    )
                  ) : (
                    <span className="block h-3.5 w-3.5" />
                  )}
                </button>
                <Folder className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                <button
                  type="button"
                  onClick={() => onToggle(n.key)}
                  className="min-w-0 flex-1 break-words text-left font-medium text-slate-700 dark:text-slate-300"
                >
                  {n.label}
                </button>
                <div className="flex shrink-0 items-start gap-0.5 pt-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                  <IconButton title="New page here" onClick={() => onNewPage(n.id, null)}>
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                  </IconButton>
                  <IconButton title="New sub-folder" onClick={() => onNewFolder(n.id)}>
                    <FolderPlus className="h-3.5 w-3.5" aria-hidden />
                  </IconButton>
                  <IconButton title="Rename" onClick={() => onRenameFolder(n.id, n.label)}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </IconButton>
                  <IconButton title="Delete folder" onClick={() => onDeleteFolder(n.id, n.label)}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </IconButton>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-1 rounded px-1 py-0.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                {n.children.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => onToggle(n.key)}
                    className="mt-0.5 shrink-0 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    aria-label={isOpen ? "Collapse" : "Expand"}
                  >
                    {isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    )}
                  </button>
                ) : (
                  <span className="mt-0.5 block h-3.5 w-3.5 shrink-0" />
                )}
                <Link
                  href={`/wiki/${n.id}`}
                  className={`min-w-0 flex-1 break-words rounded px-0.5 ${
                    n.id === activeId
                      ? "font-medium text-brand-700 dark:text-brand-200"
                      : "text-slate-700 dark:text-slate-300"
                  }`}
                >
                  {n.label}
                </Link>
                <div className="flex shrink-0 items-start gap-0.5 pt-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                  <IconButton title="New subpage here" onClick={() => onNewPage(null, n.id)}>
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                  </IconButton>
                </div>
              </div>
            )}
            {n.children.length > 0 && isOpen ? (
              <TreeList
                nodes={n.children}
                activeId={activeId}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                onNewPage={onNewPage}
                onNewFolder={onNewFolder}
                onRenameFolder={onRenameFolder}
                onDeleteFolder={onDeleteFolder}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-700 dark:hover:text-white"
    >
      {children}
    </button>
  );
}
