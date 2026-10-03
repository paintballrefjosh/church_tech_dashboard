"use client";

import { useEffect, useRef, useState } from "react";
import { Link as LinkIcon, Unlink, Check } from "lucide-react";

interface PcPerson {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  fullName: string;
}

interface MyLink {
  userId: string;
  pcPersonId: string;
  pcEmail: string | null;
  pcFirstName: string | null;
  pcLastName: string | null;
}

/**
 * Self-link UI. Shows the current link (if any) with an unlink button, or a
 * typeahead picker against /api/planning-center/people to attach a new one.
 * Auto-suggests a candidate when their PC email matches the user's local
 * email — the common case, saves a click.
 */
export function PcLinkForm({ userEmail }: { userEmail: string }) {
  const [link, setLink] = useState<MyLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);

  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<PcPerson[]>([]);
  const [searching, setSearching] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const h = await fetch("/api/planning-center/health", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (h.ok) {
          const health = (await h.json()) as { configured: boolean };
          if (!health.configured) {
            setUnconfigured(true);
            return;
          }
        }
        const r = await fetch("/api/planning-center/me/link", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (r.ok) {
          const body = (await r.json()) as MyLink | null;
          setLink(body);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Live people search. PC's search-name-or-email handles both partials so we
  // pass the query verbatim. Auto-prefills with the user's email so the
  // common "match my email" case lands as the top result on first open.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!dropdownOpen) return;
    const q = query.trim() || userEmail;
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/planning-center/people?q=${encodeURIComponent(q)}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (r.ok) setPeople((await r.json()) as PcPerson[]);
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, dropdownOpen, userEmail]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function attach(person: PcPerson) {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const r = await fetch("/api/planning-center/me/link", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pcPersonId: person.id }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        setErr(b.message ?? `Link failed (${r.status})`);
        return;
      }
      setLink((await r.json()) as MyLink);
      setDropdownOpen(false);
      setQuery("");
      setOk("Linked.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const r = await fetch("/api/planning-center/me/link", {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!r.ok) {
        setErr(`Unlink failed (${r.status})`);
        return;
      }
      setLink(null);
      setOk("Unlinked.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-xs text-slate-500">Loading…</p>;
  if (unconfigured)
    return (
      <p className="text-xs text-slate-500">
        Planning Center isn&apos;t configured yet. Ask an admin to set it up in Settings.
      </p>
    );

  if (link) {
    return (
      <div className="space-y-2 text-sm">
        <p className="inline-flex items-center gap-2">
          <Check className="h-4 w-4 text-emerald-500" aria-hidden />
          Linked to{" "}
          <span className="font-medium">
            {[link.pcFirstName, link.pcLastName].filter(Boolean).join(" ") || "(PC person)"}
          </span>
          {link.pcEmail ? (
            <span className="text-xs text-slate-500">({link.pcEmail})</span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={unlink}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-1.5 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
        >
          <Unlink className="h-3.5 w-3.5" aria-hidden /> Unlink
        </button>
        {ok ? <p className="text-xs text-emerald-600 dark:text-emerald-400">{ok}</p> : null}
        {err ? <p className="text-xs text-rose-600 dark:text-rose-400">{err}</p> : null}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setDropdownOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        <LinkIcon className="h-4 w-4" aria-hidden /> Link Planning Center account
      </button>
      {dropdownOpen ? (
        <div className="absolute left-0 z-30 mt-2 w-80 rounded-md border border-slate-300 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search by name or email (defaults to ${userEmail})`}
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
          />
          <ul className="mt-1 max-h-64 overflow-y-auto">
            {searching && people.length === 0 ? (
              <li className="p-2 text-center text-xs text-slate-500">Searching…</li>
            ) : people.length === 0 ? (
              <li className="p-2 text-center text-xs text-slate-500">No matches.</li>
            ) : (
              people.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => void attach(p)}
                    disabled={busy}
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800"
                  >
                    <span>
                      <span className="font-medium">{p.fullName || "(unnamed)"}</span>
                      {p.email ? (
                        <span className="ml-1 text-xs text-slate-500">{p.email}</span>
                      ) : null}
                    </span>
                    {p.email && p.email.toLowerCase() === userEmail.toLowerCase() ? (
                      <span className="rounded bg-brand-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
                        match
                      </span>
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
      {err ? <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{err}</p> : null}
    </div>
  );
}
