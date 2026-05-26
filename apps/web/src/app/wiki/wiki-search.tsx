"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export function WikiSearch({ defaultValue }: { defaultValue: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const [q, setQ] = useState(defaultValue);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams(search.toString());
    if (q.trim()) params.set("q", q.trim());
    else params.delete("q");
    const str = params.toString();
    router.push(str ? `/wiki?${str}` : "/wiki");
  }

  return (
    <form onSubmit={submit}>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search wiki…"
        className="w-56 rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
      />
    </form>
  );
}
