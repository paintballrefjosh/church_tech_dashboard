"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import {
  findModule,
  type ApiTokenCreate,
  type ApiTokenCreated,
  type ApiTokenPolicy,
  type ApiTokenSummary,
} from "@church/shared";
import { LocalDateTime } from "@/components/local-date-time";

/**
 * Shared pieces for personal API tokens: the list, the create form and the
 * one-time reveal. Used by /me/api-tokens, /admin/api-tokens and the
 * "Manage user" drawer (issuing tokens to service accounts).
 */

export interface ModuleChoice {
  key: string;
  label: string;
}

const DATE_ONLY: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
const DATE_TIME: Intl.DateTimeFormatOptions = { ...DATE_ONLY, hour: "numeric", minute: "2-digit" };

/** "Read-only, Wiki + Notes" / "Full access". */
export function accessLabel(t: Pick<ApiTokenSummary, "readOnly" | "modules">): string {
  const scope = t.modules?.length
    ? t.modules.map((m) => findModule(m)?.label ?? m).join(" + ")
    : "all modules";
  if (!t.readOnly && !t.modules?.length) return "Full access";
  return `${t.readOnly ? "Read-only" : "Read and write"}, ${scope}`;
}

const STATUS_STYLE: Record<ApiTokenSummary["status"], string> = {
  active: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  expired: "border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
  revoked: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

function StatusBadge({ status }: { status: ApiTokenSummary["status"] }) {
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_STYLE[status]}`}>
      {status}
    </span>
  );
}

type Owned = ApiTokenSummary & { userEmail?: string; userName?: string | null };

/**
 * Token table. Revoked and expired tokens stay listed but greyed out, so the
 * last-used details are still there when someone asks "what was this?".
 */
export function TokenTable({
  tokens,
  showOwner = false,
  onRevoke,
  busyId,
  emptyText = "No tokens yet.",
}: {
  tokens: Owned[];
  showOwner?: boolean;
  onRevoke?: (t: Owned) => void;
  busyId?: string | null;
  emptyText?: string;
}) {
  if (tokens.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500 dark:border-slate-700">
        {emptyText}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
      <table className="w-full text-left text-sm" data-testid="api-token-table">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
          <tr>
            <th className="px-3 py-2">Name</th>
            {showOwner ? <th className="px-3 py-2">Owner</th> : null}
            <th className="px-3 py-2">Access</th>
            <th className="px-3 py-2">Last used</th>
            <th className="px-3 py-2">Expires</th>
            <th className="px-3 py-2">Created</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
          {tokens.map((t) => (
            <tr key={t.id} className={`align-top ${t.status === "active" ? "" : "opacity-60"}`} data-token-id={t.id}>
              <td className="px-3 py-2">
                <div className="font-medium">{t.name}</div>
                <div className="mt-0.5 flex items-center gap-2">
                  {t.prefix ? <code className="font-mono text-[11px] text-slate-500">{t.prefix}…</code> : null}
                  <StatusBadge status={t.status} />
                </div>
              </td>
              {showOwner ? (
                <td className="px-3 py-2 text-xs">
                  {t.userName ? <div>{t.userName}</div> : null}
                  <div className="text-slate-500">{t.userEmail}</div>
                </td>
              ) : null}
              <td className="px-3 py-2 text-xs">{accessLabel(t)}</td>
              <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                {t.lastUsedAt ? (
                  <>
                    <LocalDateTime value={t.lastUsedAt} options={DATE_TIME} />
                    {t.lastUsedIp ? <div className="font-mono text-[11px] text-slate-500">{t.lastUsedIp}</div> : null}
                  </>
                ) : (
                  <span className="text-slate-400">Never</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                {t.revokedAt ? (
                  <>
                    Revoked <LocalDateTime value={t.revokedAt} options={DATE_ONLY} />
                  </>
                ) : t.expiresAt ? (
                  <LocalDateTime value={t.expiresAt} options={DATE_ONLY} />
                ) : (
                  <span className="text-amber-700 dark:text-amber-400">Never</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                <LocalDateTime value={t.createdAt} options={DATE_ONLY} />
              </td>
              <td className="px-3 py-2 text-right">
                {onRevoke && t.status === "active" ? (
                  <button
                    type="button"
                    disabled={busyId === t.id}
                    onClick={() => onRevoke(t)}
                    className="rounded-md border border-rose-300 px-2.5 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950"
                  >
                    {busyId === t.id ? "Revoking…" : "Revoke"}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The listable part of a create response: everything but the plaintext. */
export function withoutSecret(created: ApiTokenCreated): ApiTokenSummary {
  const { token, ...summary } = created;
  void token;
  return summary;
}

/** Ask before revoking; returns false when the user backs out. */
export function confirmRevoke(t: Owned): boolean {
  return confirm(
    `Revoke "${t.name}"? Anything using it stops working straight away. This can't be undone; ` +
      `make a new token if you need one again.`,
  );
}

/** The message from an API error response, or a fallback with the status. */
export async function readApiError(r: Response, fallback: string): Promise<string> {
  // Either Nest's { message: "..." } or a Zod flatten() body
  // ({ formErrors, fieldErrors }) passed straight to BadRequestException.
  const body = (await r.json().catch(() => null)) as
    | { message?: unknown; formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> }
    | null;
  if (body && typeof body.message === "string") return body.message;
  if (body) {
    const fields = Object.entries(body.fieldErrors ?? {}).map(([k, v]) => `${k}: ${(v ?? []).join(", ")}`);
    const parts = [...(body.formErrors ?? []), ...fields];
    if (parts.length) return parts.join("; ");
  }
  return `${fallback} (${r.status})`;
}

type ExpiryChoice = { kind: "days"; days: number } | { kind: "date" } | { kind: "never" };

function expiryOptions(policy: ApiTokenPolicy): Array<{ value: string; label: string; choice: ExpiryChoice }> {
  const cap = policy.maxDays;
  const days = [30, 90, 365].filter((d) => cap === 0 || d <= cap);
  if (cap > 0 && !days.includes(cap)) days.push(cap);
  const opts: Array<{ value: string; label: string; choice: ExpiryChoice }> = days
    .sort((a, b) => a - b)
    .map((d) => ({ value: `d${d}`, label: `${d} days`, choice: { kind: "days", days: d } }));
  opts.push({ value: "date", label: "On a date…", choice: { kind: "date" } });
  if (cap === 0) opts.push({ value: "never", label: "Never", choice: { kind: "never" } });
  return opts;
}

function isoDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * New-token form. Defaults follow the plan: read-only, and the policy's
 * default lifetime. `warnFullAccess` adds a warning when a read-write,
 * all-modules token would carry the owner's site-admin rights.
 */
export function TokenCreateForm({
  policy,
  modules,
  warnFullAccess = false,
  modulesHint,
  submitLabel = "Create token",
  onSubmit,
  onCancel,
}: {
  policy: ApiTokenPolicy;
  modules: ModuleChoice[];
  warnFullAccess?: boolean;
  modulesHint?: string;
  submitLabel?: string;
  onSubmit: (body: ApiTokenCreate) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const options = expiryOptions(policy);
  const defaultDays = policy.maxDays > 0 ? Math.min(policy.defaultDays, policy.maxDays) : policy.defaultDays;
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState(
    options.find((o) => o.choice.kind === "days" && o.choice.days === defaultDays)?.value ?? options[0]?.value ?? "date",
  );
  const [date, setDate] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [allModules, setAllModules] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const today = new Date();
  const minDate = isoDate(new Date(today.getTime() + 86_400_000));
  const maxDate = policy.maxDays > 0 ? isoDate(new Date(today.getTime() + policy.maxDays * 86_400_000)) : undefined;
  const choice = options.find((o) => o.value === expiry)?.choice ?? { kind: "date" };

  function toggle(key: string) {
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!allModules && picked.length === 0) {
      setErr("Pick at least one module, or allow all modules.");
      return;
    }
    const body: ApiTokenCreate = {
      name: name.trim(),
      readOnly,
      modules: allModules ? null : picked,
    };
    if (choice.kind === "days") body.expiresInDays = choice.days;
    if (choice.kind === "never") body.expiresAt = null;
    if (choice.kind === "date") {
      if (!date) {
        setErr("Pick an expiry date.");
        return;
      }
      // Local midnight at the start of the chosen day.
      body.expiresAt = new Date(`${date}T00:00:00`).toISOString();
    }
    setBusy(true);
    try {
      const failure = await onSubmit(body);
      if (failure) setErr(failure);
    } finally {
      setBusy(false);
    }
  }

  const fieldClass =
    "mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950";
  const radioRow = "flex items-start gap-2 text-sm";

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" data-testid="api-token-form">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-xs">
          <span className="text-slate-500">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            placeholder="Backup script"
            className={fieldClass}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs">
            <span className="text-slate-500">Expires</span>
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)} className={fieldClass}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {choice.kind === "date" ? (
            <label className="block text-xs">
              <span className="text-slate-500">Date</span>
              <input
                type="date"
                value={date}
                min={minDate}
                max={maxDate}
                onChange={(e) => setDate(e.target.value)}
                className={fieldClass}
              />
            </label>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset>
          <legend className="text-xs text-slate-500">Access</legend>
          <div className="mt-1 space-y-1">
            <label className={radioRow}>
              <input type="radio" name="access" checked={readOnly} onChange={() => setReadOnly(true)} className="mt-1" />
              <span>
                Read-only
                <span className="block text-xs text-slate-500">Can look things up; every change is refused.</span>
              </span>
            </label>
            <label className={radioRow}>
              <input type="radio" name="access" checked={!readOnly} onChange={() => setReadOnly(false)} className="mt-1" />
              <span>
                Read and write
                <span className="block text-xs text-slate-500">Can make changes, as the token&apos;s owner.</span>
              </span>
            </label>
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-xs text-slate-500">Modules</legend>
          <div className="mt-1 space-y-1">
            <label className={radioRow}>
              <input type="radio" name="modules" checked={allModules} onChange={() => setAllModules(true)} className="mt-1" />
              <span>All modules</span>
            </label>
            <label className={radioRow}>
              <input type="radio" name="modules" checked={!allModules} onChange={() => setAllModules(false)} className="mt-1" />
              <span>Only these:</span>
            </label>
            {!allModules ? (
              <ul className="ml-6 grid grid-cols-2 gap-x-3 gap-y-1">
                {modules.map((m) => (
                  <li key={m.key}>
                    <label className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" checked={picked.includes(m.key)} onChange={() => toggle(m.key)} />
                      {m.label}
                    </label>
                  </li>
                ))}
              </ul>
            ) : null}
            {modulesHint ? <p className="text-xs text-slate-500">{modulesHint}</p> : null}
          </div>
        </fieldset>
      </div>

      {choice.kind === "never" ? (
        <Warning>A token that never expires works until someone revokes it.</Warning>
      ) : null}
      {warnFullAccess && !readOnly && allModules ? (
        <Warning>
          This token can do everything its owner can, including administering the site. Limit it to
          the modules the script needs, or make it read-only.
        </Warning>
      ) : null}
      {err ? <p className="text-xs text-rose-600">{err}</p> : null}

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <button type="button" onClick={onCancel} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
            Cancel
          </button>
        ) : null}
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? "Creating…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/**
 * Shows a new token exactly once, with a copy button and a ready-made curl
 * call. The clipboard API only exists on HTTPS or localhost, so on a plain
 * HTTP address the button selects the text for a manual copy instead.
 */
export function TokenReveal({ created, onDone }: { created: ApiTokenCreated; onDone: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"yes" | "manual" | null>(null);
  const [origin, setOrigin] = useState("https://<your-host>");
  useEffect(() => setOrigin(window.location.origin), []);

  async function copy() {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(created.token);
        setCopied("yes");
        return;
      } catch {
        /* fall through to manual select */
      }
    }
    inputRef.current?.select();
    setCopied("manual");
  }

  return (
    <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/40" data-testid="api-token-reveal">
      <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
        Token &ldquo;{created.name}&rdquo; created. Copy it now: you won&apos;t see it again.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          ref={inputRef}
          readOnly
          value={created.token}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="New API token"
          className="w-full rounded-md border border-emerald-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-emerald-800 dark:bg-slate-950"
        />
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-emerald-400 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-slate-900 dark:text-emerald-200"
        >
          {copied === "yes" ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied === "yes" ? "Copied" : "Copy"}
        </button>
      </div>
      {copied === "manual" ? (
        <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-300">Selected. Press Ctrl+C (or Cmd+C) to copy.</p>
      ) : null}
      <p className="mt-3 text-xs text-emerald-900 dark:text-emerald-200">Try it:</p>
      <pre className="mt-1 overflow-x-auto rounded bg-white p-2 font-mono text-[11px] text-slate-800 dark:bg-slate-950 dark:text-slate-200">
        {`curl -H "Authorization: Bearer ${created.token}" \\\n  ${origin}/api/v1/me`}
      </pre>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onDone}
          className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800"
        >
          Done, I&apos;ve copied it
        </button>
      </div>
    </div>
  );
}
