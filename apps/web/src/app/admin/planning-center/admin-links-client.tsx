"use client";

import { useEffect, useRef, useState } from "react";
import { Link as LinkIcon, Unlink, Plus, X } from "lucide-react";

interface UserBrief {
  id: string;
  email: string;
  name: string | null;
}
interface LinkRow {
  userId: string;
  userEmail: string;
  userName: string | null;
  pcPersonId: string;
  pcEmail: string | null;
  pcFirstName: string | null;
  pcLastName: string | null;
  updatedAt: string;
}
interface PcPerson {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  fullName: string;
}

export function AdminLinksClient({
  initialLinks,
  users,
}: {
  initialLinks: LinkRow[];
  users: UserBrief[];
}) {
  const [links, setLinks] = useState(initialLinks);
  const [addOpen, setAddOpen] = useState(false);

  const linkedUserIds = new Set(links.map((l) => l.userId));
  const unlinkedUsers = users.filter((u) => !linkedUserIds.has(u.id));

  async function refresh() {
    const r = await fetch("/api/planning-center/links", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (r.ok) setLinks((await r.json()) as LinkRow[]);
  }

  async function unlink(userId: string, label: string) {
    if (!confirm(`Remove the Planning Center link for ${label}?`)) return;
    const r = await fetch(`/api/planning-center/links/${userId}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (r.ok) await refresh();
  }

  return (
    <div className="space-y-6">
      <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Existing links ({links.length})</h2>
          <button
            type="button"
            onClick={() => setAddOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add link
          </button>
        </div>

        {addOpen ? (
          <AddLinkPanel
            unlinkedUsers={unlinkedUsers}
            onClose={() => setAddOpen(false)}
            onCreated={async () => {
              setAddOpen(false);
              await refresh();
            }}
          />
        ) : null}

        {links.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500">
            No links yet. Users can self-link from their <code>/me</code> page, or use{" "}
            <em>Add link</em> above to map any user.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
            {links.map((l) => (
              <li key={l.userId} className="flex items-center gap-3 py-2">
                <LinkIcon className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    <span className="font-medium">{l.userName ?? l.userEmail}</span>
                    {l.userName ? (
                      <span className="ml-1 text-xs text-slate-500">{l.userEmail}</span>
                    ) : null}
                  </div>
                  <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                    →{" "}
                    {[l.pcFirstName, l.pcLastName].filter(Boolean).join(" ") || "(PC person)"}{" "}
                    {l.pcEmail ? <span>· {l.pcEmail}</span> : null}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void unlink(l.userId, l.userName ?? l.userEmail)}
                  aria-label="Unlink"
                  className="text-rose-600 hover:text-rose-700"
                >
                  <Unlink className="h-4 w-4" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AddLinkPanel({
  unlinkedUsers,
  onClose,
  onCreated,
}: {
  unlinkedUsers: UserBrief[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [pickedUser, setPickedUser] = useState<UserBrief | null>(null);
  const [pickedPerson, setPickedPerson] = useState<PcPerson | null>(null);
  const [people, setPeople] = useState<PcPerson[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live search against /api/planning-center/people. Pre-populates with the
  // picked user's email so the "match by email" path is two clicks total.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim() || pickedUser?.email || "";
    if (!q) {
      setPeople([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const r = await fetch(`/api/planning-center/people?q=${encodeURIComponent(q)}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (r.ok) setPeople((await r.json()) as PcPerson[]);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, pickedUser]);

  async function create() {
    if (!pickedUser || !pickedPerson) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/planning-center/links", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: pickedUser.id, pcPersonId: pickedPerson.id }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        setErr(b.message ?? `Link failed (${r.status})`);
        return;
      }
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-slate-300 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium uppercase tracking-wide text-slate-500">Add link</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-slate-500 hover:text-slate-900 dark:hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="text-xs text-slate-500">Local user</label>
          <select
            value={pickedUser?.id ?? ""}
            onChange={(e) =>
              setPickedUser(unlinkedUsers.find((u) => u.id === e.target.value) ?? null)
            }
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="">Pick a user…</option>
            {unlinkedUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name ?? u.email}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500">Planning Center person</label>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={pickedUser ? pickedUser.email : "Search PC people…"}
            disabled={!pickedUser}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 disabled:opacity-50"
          />
          {pickedUser && people.length > 0 ? (
            <ul className="mt-1 max-h-48 overflow-y-auto rounded border border-slate-300 dark:border-slate-700">
              {people.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setPickedPerson(p)}
                    className={`flex w-full items-center justify-between px-2 py-1 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800 ${
                      pickedPerson?.id === p.id ? "bg-brand-50 dark:bg-brand-900/30" : ""
                    }`}
                  >
                    <span>
                      <span className="font-medium">{p.fullName || "(unnamed)"}</span>
                      {p.email ? (
                        <span className="ml-1 text-slate-500">{p.email}</span>
                      ) : null}
                    </span>
                    {p.email &&
                    pickedUser.email &&
                    p.email.toLowerCase() === pickedUser.email.toLowerCase() ? (
                      <span className="rounded bg-brand-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
                        match
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {err ? <span className="text-xs text-rose-600">{err}</span> : null}
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || !pickedUser || !pickedPerson}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <LinkIcon className="h-3.5 w-3.5" aria-hidden /> Link
        </button>
      </div>
    </div>
  );
}
