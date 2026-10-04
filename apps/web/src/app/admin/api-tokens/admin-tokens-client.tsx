"use client";

import { useState } from "react";
import type { ApiTokenAdminSummary, ApiTokenSummary } from "@church/shared";
import { TokenTable, confirmRevoke, readApiError } from "@/components/api-tokens";

export function AdminTokensClient({ initialTokens }: { initialTokens: ApiTokenAdminSummary[] }) {
  const [tokens, setTokens] = useState(initialTokens);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function revoke(t: ApiTokenSummary) {
    if (!confirmRevoke(t)) return;
    setErr(null);
    setBusyId(t.id);
    try {
      const r = await fetch(`/api/admin/api-tokens/${t.id}`, { method: "DELETE", credentials: "same-origin" });
      if (!r.ok) {
        setErr(await readApiError(r, "Couldn't revoke the token"));
        return;
      }
      const updated = (await r.json()) as ApiTokenSummary;
      setTokens((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...updated } : x)));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {err ? <p className="mb-3 text-sm text-rose-600">{err}</p> : null}
      <TokenTable
        tokens={tokens}
        showOwner
        onRevoke={(t) => void revoke(t)}
        busyId={busyId}
        emptyText="No tokens match this filter."
      />
    </>
  );
}
