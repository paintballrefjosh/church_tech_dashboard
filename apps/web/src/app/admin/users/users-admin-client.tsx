"use client";

import { useEffect, useState } from "react";
import {
  ChevronDown,
  KeyRound,
  Mail,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Users as UsersIcon,
  X,
} from "lucide-react";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  isActive: boolean;
  totpEnabled: boolean;
  approvalStatus: "approved" | "pending";
  isExternal: boolean;
  deletedAt: string | null;
  createdAt: string;
}
interface GroupRow {
  id: string;
  name: string;
  description: string | null;
}
interface Assignments {
  groupIds: string[];
}

export function UsersAdminClient({
  initialUsers,
  groups,
  canWrite,
  canHardDelete,
}: {
  initialUsers: UserRow[];
  groups: GroupRow[];
  canWrite: boolean;
  canHardDelete: boolean;
}) {
  const [users, setUsers] = useState<UserRow[]>(initialUsers);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"active" | "pending" | "disabled" | "deleted">("active");

  // Each user lands in exactly one tab (precedence: deleted, then disabled, then pending).
  const deleted = users.filter((u) => u.deletedAt);
  const disabled = users.filter((u) => !u.deletedAt && !u.isActive);
  const pending = users.filter((u) => !u.deletedAt && u.isActive && u.approvalStatus === "pending");
  const active = users.filter(
    (u) => !u.deletedAt && u.isActive && u.approvalStatus !== "pending",
  );
  const visible =
    tab === "active" ? active : tab === "pending" ? pending : tab === "disabled" ? disabled : deleted;

  async function refresh() {
    const r = await fetch("/api/users", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setUsers((await r.json()) as UserRow[]);
  }

  async function toggleActive(u: UserRow) {
    const next = !u.isActive;
    const r = await fetch(`/api/users/${u.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: next }),
    });
    if (r.ok) {
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, isActive: next } : x)));
    } else {
      setErr(`Update failed (${r.status})`);
    }
  }

  async function approve(u: UserRow) {
    const r = await fetch(`/api/users/${u.id}/approve`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (r.ok) {
      setUsers((prev) =>
        prev.map((x) => (x.id === u.id ? { ...x, approvalStatus: "approved" } : x)),
      );
    } else {
      setErr(`Approve failed (${r.status})`);
    }
  }

  async function reject(u: UserRow) {
    if (
      !confirm(
        `Reject "${u.name ?? u.email}"? Their account is deactivated and they can no longer sign in.`,
      )
    ) {
      return;
    }
    const r = await fetch(`/api/users/${u.id}/reject`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (r.ok) {
      setUsers((prev) =>
        prev.map((x) =>
          x.id === u.id ? { ...x, approvalStatus: "approved", isActive: false } : x,
        ),
      );
    } else {
      setErr(`Reject failed (${r.status})`);
    }
  }

  async function restore(u: UserRow) {
    const r = await fetch(`/api/users/${u.id}/restore`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (r.ok) {
      setUsers((prev) =>
        prev.map((x) => (x.id === u.id ? { ...x, deletedAt: null, isActive: true } : x)),
      );
    } else {
      setErr(`Restore failed (${r.status})`);
    }
  }

  async function hardDelete(u: UserRow) {
    if (
      !confirm(
        `Permanently delete "${u.name ?? u.email}"? This CANNOT be undone — their account, ` +
          `owned notes/tickets/wiki pages, and audit attribution are erased, and the email ` +
          `becomes available again.`,
      )
    ) {
      return;
    }
    const r = await fetch(`/api/users/${u.id}/hard-delete`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (r.ok) {
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
    } else {
      const body = (await r.json().catch(() => ({}))) as { message?: string };
      setErr(body.message ?? `Hard delete failed (${r.status})`);
    }
  }

  return (
    <div className="mt-6">
      {err ? (
        <p role="alert" className="mb-3 text-sm text-rose-600">
          {err}
        </p>
      ) : null}

      {canWrite ? (
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" aria-hidden /> New user
          </button>
        </div>
      ) : null}

      <div className="mb-4 flex items-center gap-2 border-b border-slate-300 text-sm dark:border-slate-800">
        <TabButton active={tab === "active"} onClick={() => setTab("active")}>
          Active ({active.length})
        </TabButton>
        <TabButton active={tab === "pending"} onClick={() => setTab("pending")}>
          <span className="inline-flex items-center gap-1.5">
            Pending ({pending.length})
            {pending.length > 0 ? (
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500"
              />
            ) : null}
          </span>
        </TabButton>
        <TabButton active={tab === "disabled"} onClick={() => setTab("disabled")}>
          Disabled ({disabled.length})
        </TabButton>
        <TabButton active={tab === "deleted"} onClick={() => setTab("deleted")}>
          Deleted ({deleted.length})
        </TabButton>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
          {tab === "active"
            ? "No active users."
            : tab === "pending"
              ? "No pending users."
              : tab === "disabled"
                ? "No disabled users."
                : "No deleted users."}
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
          {visible.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{u.name ?? u.email}</div>
                {u.name ? (
                  <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {u.email}
                  </div>
                ) : null}
              </div>
              {u.approvalStatus === "pending" ? (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                  pending approval
                </span>
              ) : null}
              {u.isExternal ? (
                <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
                  external
                </span>
              ) : null}
              {u.deletedAt ? (
                <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium text-rose-800 dark:bg-rose-900/40 dark:text-rose-200">
                  deleted
                </span>
              ) : (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    u.isActive
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
                      : "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  }`}
                >
                  {u.isActive ? "active" : "disabled"}
                </span>
              )}
              {u.totpEnabled ? (
                <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">
                  TOTP
                </span>
              ) : null}
              {canWrite && !u.deletedAt && u.approvalStatus === "pending" ? (
                <>
                  <button
                    type="button"
                    onClick={() => void approve(u)}
                    className="rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => void reject(u)}
                    className="rounded-md border border-rose-300 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-950/40"
                  >
                    Reject
                  </button>
                </>
              ) : null}
              {canWrite && u.deletedAt ? (
                <button
                  type="button"
                  onClick={() => void restore(u)}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden /> Restore
                </button>
              ) : null}
              {canHardDelete && u.deletedAt ? (
                <button
                  type="button"
                  onClick={() => void hardDelete(u)}
                  title="Permanently delete this account (irreversible)"
                  className="inline-flex items-center gap-1 rounded-md border border-rose-400 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-950/40"
                >
                  <Trash2 className="h-3 w-3" aria-hidden /> Delete permanently
                </button>
              ) : null}
              {canWrite && !u.deletedAt ? (
                <>
                  <button
                    type="button"
                    onClick={() => void toggleActive(u)}
                    className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  >
                    {u.isActive ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(u)}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    <Pencil className="h-3 w-3" aria-hidden /> Manage
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <ManageDrawer
          user={editing}
          groups={groups}
          onClose={() => {
            setEditing(null);
            void refresh();
          }}
          onSoftDeleted={(id) => {
            // Soft-delete keeps the row — mark it tombstoned so it moves to the
            // Deleted tab and the tab counts update immediately (no refresh).
            setUsers((prev) =>
              prev.map((x) =>
                x.id === id
                  ? { ...x, deletedAt: new Date().toISOString(), isActive: false }
                  : x,
              ),
            );
            setEditing(null);
          }}
          onError={(msg) => setErr(msg)}
        />
      ) : null}

      {creating ? (
        <CreateDrawer
          groups={groups}
          onClose={() => {
            setCreating(false);
            void refresh();
          }}
          onError={(msg) => setErr(msg)}
        />
      ) : null}
    </div>
  );
}

function CreateDrawer({
  groups,
  onClose,
  onError,
}: {
  groups: GroupRow[];
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<"invite" | "password">("invite");
  const [password, setPassword] = useState("");
  const [groupNames, setGroupNames] = useState<string[]>([]);
  const [mustChangePassword, setMustChangePassword] = useState(true);
  const [sendWelcomeEmail, setSendWelcomeEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  function toggleGroup(name: string) {
    setGroupNames((prev) => (prev.includes(name) ? prev.filter((k) => k !== name) : [...prev, name]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalErr(null);
    if (mode === "password" && password.length < 12) {
      setLocalErr("Password must be at least 12 characters.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/users", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          displayName: displayName.trim(),
          groupNames: groupNames.length ? groupNames : undefined,
          sendInvite: mode === "invite",
          ...(mode === "password" ? { password, mustChangePassword, sendWelcomeEmail } : {}),
          appOrigin: typeof window !== "undefined" ? window.location.origin : undefined,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        setLocalErr(body.message ?? `Create failed (${r.status})`);
        return;
      }
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DrawerShell title="New user" onClose={onClose}>
      <form onSubmit={submit} className="flex h-full flex-col">
        <label className="mb-3 block text-xs">
          <span className="text-slate-500">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        <label className="mb-3 block text-xs">
          <span className="text-slate-500">Display name</span>
          <input
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={120}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        <div className="mb-4">
          <span className="mb-1 block text-xs text-slate-500">How they get access</span>
          <div className="grid grid-cols-2 gap-2">
            {(["invite", "password"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-md border px-2 py-1.5 text-xs font-medium ${
                  mode === m
                    ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {m === "invite" ? "Email an invite" : "Set a password"}
              </button>
            ))}
          </div>
        </div>

        {mode === "invite" ? (
          <p className="mb-4 rounded-md border border-brand-500/40 bg-brand-50 px-3 py-2 text-[11px] text-slate-600 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-slate-300">
            We&apos;ll email {email.trim() || "the user"} a one-time link to choose their own
            password and sign in — nothing to share by hand. Needs SMTP configured under
            Admin &gt; Settings; the link expires after a few days.
          </p>
        ) : (
          <>
            <label className="mb-4 block text-xs">
              <span className="text-slate-500">Password (≥12 chars)</span>
              <input
                type="password"
                required
                minLength={12}
                maxLength={256}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-mono dark:border-slate-700 dark:bg-slate-950"
              />
              <span className="mt-1 block text-[10px] text-slate-500">
                You&apos;ll need to share this with the user yourself, or rely on the welcome
                email below.
              </span>
            </label>

            <label className="mb-3 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={mustChangePassword}
                onChange={(e) => setMustChangePassword(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Require password change on first sign-in</span>
                <span className="block text-[10px] text-slate-500">
                  The user is bounced to /change-password before they can use anything, so your
                  initial password is never permanent.
                </span>
              </span>
            </label>

            <label className="mb-4 flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={sendWelcomeEmail}
                onChange={(e) => setSendWelcomeEmail(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Send welcome email</span>
                <span className="block text-[10px] text-slate-500">
                  Emails the new user a &quot;get started&quot; link to sign in. Needs SMTP
                  configured under Admin &gt; Settings; otherwise it is silently skipped.
                </span>
              </span>
            </label>
          </>
        )}

        <section className="mb-4">
          <h3 className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <UsersIcon className="h-3 w-3" aria-hidden /> Groups
          </h3>
          {groups.length === 0 ? (
            <p className="text-xs text-slate-500">No groups defined.</p>
          ) : (
            <ul className="space-y-1">
              {groups.map((g) => (
                <li key={g.id}>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={groupNames.includes(g.name)}
                      onChange={() => toggleGroup(g.name)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-mono text-xs">{g.name}</span>
                      {g.description ? (
                        <span className="block text-xs text-slate-500 dark:text-slate-400">
                          {g.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[10px] text-slate-500">
            Leave empty to fall back to the default <code className="font-mono">user</code> group.
          </p>
        </section>

        {localErr ? (
          <p role="alert" className="mb-3 text-xs text-rose-600">
            {localErr}
          </p>
        ) : null}

        <div className="mt-auto flex justify-end gap-2 border-t border-slate-300 pt-4 dark:border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create user"}
          </button>
        </div>
      </form>
    </DrawerShell>
  );
}

function ManageDrawer({
  user,
  groups,
  onClose,
  onSoftDeleted,
  onError,
}: {
  user: UserRow;
  groups: GroupRow[];
  onClose: () => void;
  onSoftDeleted: (id: string) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState<string>(user.name ?? "");
  const [assignments, setAssignments] = useState<Assignments | null>(null);
  const [busy, setBusy] = useState(false);

  const [resetPwd, setResetPwd] = useState("");
  const [resetMust, setResetMust] = useState(true);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [resetOpen, setResetOpen] = useState(true);
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  const [welcomeMsg, setWelcomeMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await fetch(`/api/users/${user.id}/assignments`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!r.ok || cancelled) return;
      setAssignments((await r.json()) as Assignments);
    })();
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  function toggleGroup(id: string) {
    if (!assignments) return;
    const has = assignments.groupIds.includes(id);
    setAssignments({
      groupIds: has
        ? assignments.groupIds.filter((g) => g !== id)
        : [...assignments.groupIds, id],
    });
  }

  async function save() {
    if (!assignments) return;
    setBusy(true);
    try {
      const calls: Promise<Response>[] = [];
      if ((name.trim() || null) !== (user.name ?? null)) {
        calls.push(
          fetch(`/api/users/${user.id}`, {
            method: "PATCH",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ displayName: name.trim() || null }),
          }),
        );
      }
      calls.push(
        fetch(`/api/users/${user.id}/groups`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ groupIds: assignments.groupIds }),
        }),
      );
      const results = await Promise.all(calls);
      const failed = results.find((r) => !r.ok);
      if (failed) {
        onError(`Save failed (${failed.status})`);
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function resendWelcome() {
    setWelcomeMsg(null);
    setWelcomeBusy(true);
    try {
      const r = await fetch(`/api/users/${user.id}/resend-welcome`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appOrigin: typeof window !== "undefined" ? window.location.origin : undefined,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        setWelcomeMsg({ kind: "err", text: body.message ?? `Send failed (${r.status})` });
        return;
      }
      setWelcomeMsg({
        kind: "ok",
        text: `Welcome email queued to ${user.email}. If SMTP is configured it will arrive shortly.`,
      });
    } finally {
      setWelcomeBusy(false);
    }
  }

  async function resetPassword() {
    setResetMsg(null);
    if (resetPwd.length < 12) {
      setResetMsg({ kind: "err", text: "Password must be at least 12 characters." });
      return;
    }
    setResetBusy(true);
    try {
      const r = await fetch(`/api/users/${user.id}/password`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: resetPwd, mustChangePassword: resetMust }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        setResetMsg({ kind: "err", text: body.message ?? `Reset failed (${r.status})` });
        return;
      }
      setResetPwd("");
      setResetMsg({
        kind: "ok",
        text: resetMust
          ? "Password updated — user will be prompted to change it on next sign-in."
          : "Password updated.",
      });
    } finally {
      setResetBusy(false);
    }
  }

  async function destroy() {
    if (
      !confirm(
        `Delete user "${user.name ?? user.email}"? Their account is locked out and hidden, ` +
          `but their notes/tickets and audit history are kept. You can restore them later ` +
          `from the Deleted tab.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/users/${user.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        onError(body.message ?? `Delete failed (${r.status})`);
        return;
      }
      onSoftDeleted(user.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DrawerShell title="Manage user" subtitle={user.email} onClose={onClose} wide>
      <label className="mb-4 block text-xs">
        <span className="text-slate-500">Display name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
      </label>

      <section className="mb-4">
        <button
          type="button"
          onClick={() => setGroupsOpen((o) => !o)}
          aria-expanded={groupsOpen}
          className="mb-2 flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform ${groupsOpen ? "" : "-rotate-90"}`}
            aria-hidden
          />
          <UsersIcon className="h-3 w-3" aria-hidden /> Groups
        </button>
        {!groupsOpen ? null : assignments ? (
          groups.length === 0 ? (
            <p className="text-xs text-slate-500">No groups defined.</p>
          ) : (
            <ul className="space-y-1">
              {groups.map((g) => (
                <li key={g.id}>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={assignments.groupIds.includes(g.id)}
                      onChange={() => toggleGroup(g.id)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-mono text-xs">{g.name}</span>
                      {g.description ? (
                        <span className="block text-xs text-slate-500 dark:text-slate-400">
                          {g.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="text-xs text-slate-500">Loading…</p>
        )}
      </section>

      <section className="mb-4 rounded-md border border-slate-300 p-3 dark:border-slate-800">
        <div className="flex items-center justify-between gap-2">
          <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
            <Mail className="h-3 w-3" aria-hidden /> Welcome email
          </h3>
          <button
            type="button"
            disabled={welcomeBusy}
            onClick={() => void resendWelcome()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            {welcomeBusy ? "Sending…" : "Resend welcome email"}
          </button>
        </div>
        <p className="mt-1 text-[10px] text-slate-500">
          Re-sends the &quot;get started&quot; sign-in link to {user.email}. Needs SMTP configured
          under Admin &gt; Settings.
        </p>
        {welcomeMsg ? (
          <p
            className={`mt-2 text-xs ${
              welcomeMsg.kind === "ok" ? "text-emerald-600" : "text-rose-600"
            }`}
          >
            {welcomeMsg.text}
          </p>
        ) : null}
      </section>

      <section className="mb-4 rounded-md border border-slate-300 p-3 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setResetOpen((o) => !o)}
          aria-expanded={resetOpen}
          className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform ${resetOpen ? "" : "-rotate-90"}`}
            aria-hidden
          />
          <KeyRound className="h-3 w-3" aria-hidden /> Reset password
        </button>
        {!resetOpen ? null : (
        <div className="mt-2">
        <label className="block text-xs">
          <span className="text-slate-500">New password (≥12 chars)</span>
          <input
            type="password"
            value={resetPwd}
            onChange={(e) => setResetPwd(e.target.value)}
            minLength={12}
            maxLength={256}
            autoComplete="new-password"
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-mono dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        <label className="mt-2 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={resetMust}
            onChange={(e) => setResetMust(e.target.checked)}
          />
          <span>Require user to change it on next sign-in</span>
        </label>
        {resetMsg ? (
          <p
            className={`mt-2 text-xs ${
              resetMsg.kind === "ok" ? "text-emerald-600" : "text-rose-600"
            }`}
          >
            {resetMsg.text}
          </p>
        ) : null}
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            disabled={resetBusy || resetPwd.length < 12}
            onClick={() => void resetPassword()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            {resetBusy ? "Resetting…" : "Reset password"}
          </button>
        </div>
        </div>
        )}
      </section>

      <section className="mb-4 rounded-md border border-rose-300 bg-rose-50 p-3 dark:border-rose-800 dark:bg-rose-950/40">
        <h3 className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">
          <Trash2 className="h-3 w-3" aria-hidden /> Danger zone
        </h3>
        <p className="mb-2 text-xs text-rose-700 dark:text-rose-300">
          Deleting locks the account out and hides it everywhere, but keeps their notes /
          tickets and audit history. The email stays reserved; restore from the Deleted tab
          to bring them back. Use Disable instead for a temporary, fully reversible pause.
        </p>
        <div className="flex justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={() => void destroy()}
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-400 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-700 dark:text-rose-200 dark:hover:bg-rose-900/40"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete user
          </button>
        </div>
      </section>

      <div className="mt-auto flex justify-end gap-2 border-t border-slate-300 pt-4 dark:border-slate-800">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !assignments}
          onClick={() => void save()}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </DrawerShell>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-[-1px] border-b-2 px-3 py-2 ${
        active
          ? "border-brand-600 text-brand-700 dark:text-brand-300"
          : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function DrawerShell({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Centered, wider modal (vs the default right-side drawer). */
  wide?: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className={`fixed inset-0 z-[1000] flex bg-black/40 p-4 ${
        wide ? "items-center justify-center" : "items-start justify-end"
      }`}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        className={`flex w-full flex-col overflow-y-auto border border-slate-300 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900 ${
          wide
            ? "max-h-[85vh] max-w-2xl rounded-lg p-6"
            : "h-full max-w-md rounded-md p-5"
        }`}
      >
        <header className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            {subtitle ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
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
        {children}
      </aside>
    </div>
  );
}
