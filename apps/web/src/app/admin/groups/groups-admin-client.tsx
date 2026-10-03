"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Lock, Plus, Search, Trash2, ShieldCheck, UsersRound, X } from "lucide-react";

type Tier = "user" | "moderator" | "admin";

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  googleGroupEmail: string | null;
  isManaged: boolean;
  isSystem: boolean;
  createdAt: string;
}
interface UserRow {
  id: string;
  email: string;
  name: string | null;
  isActive?: boolean;
  deletedAt?: string | null;
}
interface ModuleDef {
  key: string;
  label: string;
  description: string;
  tiers: readonly Tier[];
}

const ADMIN_GROUP_NAME = "admin";

export function GroupsAdminClient({
  initialGroups,
  modules,
  users,
  canWrite,
}: {
  initialGroups: GroupRow[];
  modules: ModuleDef[];
  users: UserRow[];
  canWrite: boolean;
}) {
  const [groups, setGroups] = useState<GroupRow[]>(initialGroups);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<GroupRow | null>(null);

  async function refresh() {
    const r = await fetch("/api/groups", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setGroups((await r.json()) as GroupRow[]);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/groups", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      });
      if (!r.ok) {
        setErr(`Create failed (${r.status})`);
        return;
      }
      setName("");
      setDescription("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function destroy(g: GroupRow) {
    if (!confirm(`Delete group "${g.name}"? Members and grants will be removed.`)) return;
    const r = await fetch(`/api/groups/${g.id}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (r.ok) {
      setGroups((prev) => prev.filter((x) => x.id !== g.id));
    } else {
      const body = (await r.json().catch(() => ({}))) as { message?: string };
      setErr(body.message ?? `Delete failed (${r.status})`);
    }
  }

  return (
    <div className="mt-6 space-y-6">
      {canWrite ? (
        <form
          onSubmit={create}
          className="flex flex-wrap items-end gap-2 rounded-md border border-slate-300 p-4 dark:border-slate-800"
        >
          <label className="flex flex-col text-xs">
            <span className="text-slate-500">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="worship-team, av-volunteers…"
              maxLength={120}
              required
              className="mt-1 w-56 rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <label className="flex flex-1 flex-col text-xs">
            <span className="text-slate-500">Description (optional)</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden /> Create group
          </button>
          {err ? <span className="text-xs text-rose-600">{err}</span> : null}
        </form>
      ) : (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          You don't have the <code className="font-mono">user:admin</code> permission, so this
          page is read-only.
        </p>
      )}

      {err && !busy ? (
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
          {err}
        </p>
      ) : null}

      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
          No groups yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
          {groups.map((g) => {
            const isAdmin = g.name === ADMIN_GROUP_NAME;
            return (
              <li key={g.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{g.name}</div>
                  {g.description ? (
                    <div className="text-xs text-slate-500 dark:text-slate-400">{g.description}</div>
                  ) : null}
                  {g.googleGroupEmail ? (
                    <div className="font-mono text-[10px] text-slate-400">{g.googleGroupEmail}</div>
                  ) : null}
                </div>
                {g.isSystem ? (
                  <span
                    className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                    title="System group — cannot be deleted"
                  >
                    <Lock className="h-2.5 w-2.5" aria-hidden /> system
                  </span>
                ) : null}
                {g.isManaged ? (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">
                    google-managed
                  </span>
                ) : null}
                {canWrite ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setEditing(g)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                    >
                      <ShieldCheck className="h-3 w-3" aria-hidden /> {isAdmin ? "View" : "Manage"}
                    </button>
                    {g.isSystem ? null : (
                      <button
                        type="button"
                        onClick={() => void destroy(g)}
                        aria-label={`Delete ${g.name}`}
                        className="text-rose-600 hover:text-rose-700"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {editing ? (
        <GroupDrawer
          group={editing}
          modules={modules}
          users={users}
          onClose={() => {
            setEditing(null);
            void refresh();
          }}
          onError={setErr}
        />
      ) : null}
    </div>
  );
}

function GroupDrawer({
  group,
  modules,
  users,
  onClose,
  onError,
}: {
  group: GroupRow;
  modules: ModuleDef[];
  users: UserRow[];
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const isAdminGroup = group.name === ADMIN_GROUP_NAME;
  const [access, setAccess] = useState<Record<string, Tier> | null>(null);
  const [members, setMembers] = useState<UserRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string>(group.name);
  const [description, setDescription] = useState<string>(group.description ?? "");
  const [membersOpen, setMembersOpen] = useState(true);
  const [accessOpen, setAccessOpen] = useState(true);
  const [memberSearch, setMemberSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [aRes, mRes] = await Promise.all([
        fetch(`/api/groups/${group.id}/module-access`, {
          credentials: "same-origin",
          cache: "no-store",
        }),
        fetch(`/api/groups/${group.id}/members`, {
          credentials: "same-origin",
          cache: "no-store",
        }),
      ]);
      if (cancelled) return;
      if (isAdminGroup) {
        // Show every module pinned at the highest tier — the API short-circuits
        // the admin group server-side too.
        const all: Record<string, Tier> = {};
        for (const m of modules) all[m.key] = m.tiers[m.tiers.length - 1]!;
        setAccess(all);
      } else if (aRes.ok) {
        setAccess((await aRes.json()) as Record<string, Tier>);
      } else {
        setAccess({});
      }
      if (mRes.ok) setMembers((await mRes.json()) as UserRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [group.id, isAdminGroup, modules]);

  function setTier(moduleKey: string, tier: Tier | "") {
    if (!access || isAdminGroup) return;
    const next = { ...access };
    if (tier === "") delete next[moduleKey];
    else next[moduleKey] = tier;
    setAccess(next);
  }

  async function addMember(userId: string) {
    const r = await fetch(`/api/groups/${group.id}/members`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (r.ok) {
      const u = users.find((x) => x.id === userId);
      if (u && members) setMembers([...members, u]);
    } else onError(`Add failed (${r.status})`);
  }
  async function removeMember(userId: string) {
    const r = await fetch(`/api/groups/${group.id}/members/${userId}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (r.ok && members) setMembers(members.filter((m) => m.id !== userId));
    else if (!r.ok) onError(`Remove failed (${r.status})`);
  }

  async function save() {
    if (!access) return;
    setBusy(true);
    try {
      const calls: Promise<Response>[] = [];
      const trimmedName = name.trim();
      const trimmedDesc = description.trim();
      const renamed = !isAdminGroup && trimmedName && trimmedName !== group.name;
      const descChanged = !isAdminGroup && (trimmedDesc || null) !== (group.description ?? null);
      if (renamed || descChanged) {
        calls.push(
          fetch(`/api/groups/${group.id}`, {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...(renamed ? { name: trimmedName } : {}),
              ...(descChanged ? { description: trimmedDesc || null } : {}),
            }),
          }),
        );
      }
      if (!isAdminGroup) {
        // Full-replace: send the current map; any module not in `access` is
        // implicitly removed by setModuleAccess server-side.
        calls.push(
          fetch(`/api/groups/${group.id}/module-access`, {
            method: "PUT",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ access }),
          }),
        );
      }
      const results = await Promise.all(calls);
      const failed = results.find((r) => !r.ok);
      if (failed) {
        const body = (await failed.json().catch(() => ({}))) as { message?: string };
        onError(body.message ?? `Save failed (${failed.status})`);
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const memberIds = new Set(members?.map((m) => m.id) ?? []);
  // The selectable pool: currently active accounts (disabled + soft-deleted are
  // excluded), plus any existing members so they can still be unchecked.
  const memberPool = users.filter(
    (u) => (u.isActive !== false && !u.deletedAt) || memberIds.has(u.id),
  );
  const memberQuery = memberSearch.trim().toLowerCase();
  const filteredPool = memberQuery
    ? memberPool.filter(
        (u) =>
          (u.name ?? "").toLowerCase().includes(memberQuery) ||
          u.email.toLowerCase().includes(memberQuery),
      )
    : memberPool;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4"
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-y-auto rounded-lg border border-slate-300 bg-white p-6 shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <header className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">{isAdminGroup ? "Administrator group" : "Manage group"}</h2>
            <p className="font-mono text-[10px] text-slate-400">{group.id}</p>
            {isAdminGroup ? (
              <p className="mt-1 inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                <Lock className="h-3 w-3" aria-hidden /> Locked — always has admin access to every module.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <label className="mb-3 block text-xs">
          <span className="text-slate-500">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isAdminGroup || group.isManaged}
            maxLength={120}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 disabled:opacity-60"
          />
        </label>
        <label className="mb-4 block text-xs">
          <span className="text-slate-500">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isAdminGroup}
            maxLength={500}
            placeholder="What is this group for?"
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 disabled:opacity-60"
          />
        </label>

        <section className="mb-4">
          <button
            type="button"
            onClick={() => setMembersOpen((o) => !o)}
            aria-expanded={membersOpen}
            className="mb-2 flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${membersOpen ? "" : "-rotate-90"}`}
              aria-hidden
            />
            <UsersRound className="h-3 w-3" aria-hidden /> Members ({members?.length ?? "…"})
          </button>
          {!membersOpen ? null : members === null ? (
            <p className="text-xs text-slate-500">Loading…</p>
          ) : (
            <>
              <div className="relative mb-2">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                  aria-hidden
                />
                <input
                  type="search"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder="Search users by name or email…"
                  className="w-full rounded-md border border-slate-300 py-1.5 pl-7 pr-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div className="max-h-64 overflow-y-auto rounded-md border border-slate-300 dark:border-slate-800">
                {filteredPool.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-slate-500">
                    {memberQuery ? "No matching users." : "No users."}
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {filteredPool.map((u) => {
                      const checked = memberIds.has(u.id);
                      return (
                        <li key={u.id}>
                          <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                void (checked ? removeMember(u.id) : addMember(u.id))
                              }
                              className="h-4 w-4 shrink-0"
                            />
                            <span className="min-w-0 flex-1 truncate">
                              {u.name ?? u.email}
                              {u.name ? (
                                <span className="ml-1.5 text-xs text-slate-400">{u.email}</span>
                              ) : null}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>

        <section className="mb-4 flex-1">
          <button
            type="button"
            onClick={() => setAccessOpen((o) => !o)}
            aria-expanded={accessOpen}
            className="mb-2 flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${accessOpen ? "" : "-rotate-90"}`}
              aria-hidden
            />
            <ShieldCheck className="h-3 w-3" aria-hidden /> Module access
          </button>
          {!accessOpen ? null : access === null ? (
            <p className="text-xs text-slate-500">Loading…</p>
          ) : (
            <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
              {modules.map((m) => {
                const current: Tier | "" = access[m.key] ?? "";
                const onlyAdmin = m.tiers.length === 1 && m.tiers[0] === "admin";
                return (
                  <li key={m.key} className="flex items-start gap-2 px-3 py-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{m.label}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {m.description}
                      </div>
                    </div>
                    <select
                      value={current}
                      disabled={isAdminGroup}
                      onChange={(e) => setTier(m.key, e.target.value as Tier | "")}
                      className="shrink-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950"
                    >
                      <option value="">None</option>
                      {m.tiers.map((t) => (
                        <option key={t} value={t}>
                          {onlyAdmin ? "Admin" : capitalise(t)}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="mt-auto flex justify-end gap-2 border-t border-slate-300 pt-4 dark:border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
          >
            {isAdminGroup ? "Close" : "Cancel"}
          </button>
          {isAdminGroup ? null : (
            <button
              type="button"
              disabled={busy || access === null}
              onClick={() => void save()}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
