"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import type { ApiTokenCreate, ApiTokenCreated, ApiTokenPolicy, ApiTokenSummary } from "@church/shared";
import {
  TokenCreateForm,
  TokenReveal,
  TokenTable,
  confirmRevoke,
  readApiError,
  withoutSecret,
  type ModuleChoice,
} from "@/components/api-tokens";

export function MyTokensClient({
  initialTokens,
  policy,
  modules,
  warnFullAccess,
}: {
  initialTokens: ApiTokenSummary[];
  policy: ApiTokenPolicy;
  modules: ModuleChoice[];
  warnFullAccess: boolean;
}) {
  const [tokens, setTokens] = useState(initialTokens);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function create(body: ApiTokenCreate): Promise<string | null> {
    const r = await fetch("/api/me/api-tokens", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return readApiError(r, "Couldn't create the token");
    const token = (await r.json()) as ApiTokenCreated;
    setTokens((prev) => [withoutSecret(token), ...prev]);
    setCreated(token);
    setCreating(false);
    return null;
  }

  async function revoke(t: ApiTokenSummary) {
    if (!confirmRevoke(t)) return;
    setErr(null);
    setBusyId(t.id);
    try {
      const r = await fetch(`/api/me/api-tokens/${t.id}`, { method: "DELETE", credentials: "same-origin" });
      if (!r.ok) {
        setErr(await readApiError(r, "Couldn't revoke the token"));
        return;
      }
      const updated = (await r.json()) as ApiTokenSummary;
      setTokens((prev) => prev.map((x) => (x.id === t.id ? updated : x)));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mt-8 space-y-4">
      {!policy.enabled ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          An administrator has turned API tokens off, so none of these work at the moment and new
          ones can&apos;t be created.
        </p>
      ) : null}

      {created ? <TokenReveal created={created} onDone={() => setCreated(null)} /> : null}

      {creating ? (
        <section className="rounded-md border border-slate-300 p-5 dark:border-slate-800">
          <h2 className="mb-4 text-lg font-medium">New token</h2>
          <TokenCreateForm
            policy={policy}
            modules={modules}
            warnFullAccess={warnFullAccess}
            onSubmit={create}
            onCancel={() => setCreating(false)}
          />
        </section>
      ) : policy.enabled && !created ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" aria-hidden /> New token
        </button>
      ) : null}

      {err ? <p className="text-sm text-rose-600">{err}</p> : null}
      <TokenTable
        tokens={tokens}
        onRevoke={(t) => void revoke(t)}
        busyId={busyId}
        emptyText="You have no API tokens."
      />
      <p className="text-xs text-slate-500">
        Revoked and expired tokens stay listed for 90 days.
      </p>
    </div>
  );
}
