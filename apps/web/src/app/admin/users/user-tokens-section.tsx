"use client";

import { useEffect, useState } from "react";
import { ChevronDown, KeySquare } from "lucide-react";
import {
  MODULES,
  type ApiTokenAdminSummary,
  type ApiTokenCreate,
  type ApiTokenCreated,
  type ApiTokenPolicy,
  type ApiTokenSummary,
} from "@church/shared";
import {
  TokenCreateForm,
  TokenReveal,
  TokenTable,
  confirmRevoke,
  readApiError,
  withoutSecret,
} from "@/components/api-tokens";

const ALL_MODULES = MODULES.map((m) => ({ key: m.key, label: m.label }));

/**
 * "API tokens" section of the Manage user drawer: the user's token count and
 * list, revoke one or all, and issue a new token. Issuing is how a
 * passwordless service account (e.g. "Claude (docs)") gets its token.
 */
export function UserTokensSection({
  userId,
  userEmail,
  userName,
}: {
  userId: string;
  userEmail: string;
  userName: string | null;
}) {
  const userLabel = userName ?? userEmail;
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<ApiTokenAdminSummary[] | null>(null);
  const [policy, setPolicy] = useState<ApiTokenPolicy | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [list, pol] = await Promise.all([
        fetch(`/api/admin/api-tokens?userId=${userId}`, { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/me/api-tokens/policy", { credentials: "same-origin", cache: "no-store" }),
      ]);
      if (cancelled) return;
      if (list.ok) setTokens((await list.json()) as ApiTokenAdminSummary[]);
      if (pol.ok) setPolicy((await pol.json()) as ApiTokenPolicy);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const active = tokens?.filter((t) => t.status === "active").length ?? 0;

  function merge(updated: ApiTokenSummary) {
    setTokens((prev) => prev?.map((x) => (x.id === updated.id ? { ...x, ...updated } : x)) ?? prev);
  }

  async function issue(body: ApiTokenCreate): Promise<string | null> {
    const r = await fetch(`/api/admin/users/${userId}/api-tokens`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return readApiError(r, "Couldn't issue the token");
    const token = (await r.json()) as ApiTokenCreated;
    setTokens((prev) => [{ ...withoutSecret(token), userEmail, userName }, ...(prev ?? [])]);
    setCreated(token);
    setIssuing(false);
    return null;
  }

  async function revoke(t: ApiTokenSummary) {
    if (!confirmRevoke(t)) return;
    setMsg(null);
    setBusyId(t.id);
    try {
      const r = await fetch(`/api/admin/api-tokens/${t.id}`, { method: "DELETE", credentials: "same-origin" });
      if (!r.ok) {
        setMsg({ kind: "err", text: await readApiError(r, "Couldn't revoke the token") });
        return;
      }
      merge((await r.json()) as ApiTokenSummary);
    } finally {
      setBusyId(null);
    }
  }

  async function revokeAll() {
    if (!confirm(`Revoke all ${active} active API tokens for ${userLabel}? Anything using them stops working.`)) return;
    setMsg(null);
    const r = await fetch(`/api/admin/users/${userId}/api-tokens/revoke-all`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (!r.ok) {
      setMsg({ kind: "err", text: await readApiError(r, "Couldn't revoke the tokens") });
      return;
    }
    const { revoked } = (await r.json()) as { revoked: number };
    const now = new Date().toISOString();
    setTokens((prev) =>
      prev?.map((x) => (x.status === "active" ? { ...x, status: "revoked", revokedAt: now } : x)) ?? prev,
    );
    setMsg({ kind: "ok", text: `Revoked ${revoked} ${revoked === 1 ? "token" : "tokens"}.` });
  }

  return (
    <section className="mb-4 rounded-md border border-slate-300 p-3 dark:border-slate-800" data-testid="user-api-tokens">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden />
        <KeySquare className="h-3 w-3" aria-hidden /> API tokens
        <span className="ml-1 font-normal normal-case tracking-normal text-slate-500">
          {tokens === null ? "" : `${active} active`}
        </span>
      </button>
      {!open ? null : (
        <div className="mt-3 space-y-3">
          {created ? <TokenReveal created={created} onDone={() => setCreated(null)} /> : null}
          {issuing && policy ? (
            <TokenCreateForm
              policy={policy}
              modules={ALL_MODULES}
              modulesHint="Only modules this user's groups can reach will be accepted."
              submitLabel="Issue token"
              onSubmit={issue}
              onCancel={() => setIssuing(false)}
            />
          ) : null}
          {msg ? (
            <p className={`text-xs ${msg.kind === "ok" ? "text-emerald-600" : "text-rose-600"}`}>{msg.text}</p>
          ) : null}
          {tokens === null ? (
            <p className="text-xs text-slate-500">Loading…</p>
          ) : (
            <TokenTable tokens={tokens} onRevoke={(t) => void revoke(t)} busyId={busyId} emptyText="No API tokens." />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {active > 0 ? (
              <button
                type="button"
                onClick={() => void revokeAll()}
                className="rounded-md border border-rose-300 px-3 py-1.5 text-xs text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950"
              >
                Revoke all
              </button>
            ) : null}
            {!issuing && !created && policy?.enabled ? (
              <button
                type="button"
                onClick={() => setIssuing(true)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Issue token
              </button>
            ) : null}
          </div>
          <p className="text-[10px] text-slate-500">
            For a script or an AI agent that should act as this user, e.g. a service account with no
            password. The token is shown once, here, to you.
          </p>
        </div>
      )}
    </section>
  );
}
