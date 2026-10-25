"use client";

import { useCallback, useState } from "react";
import { Cctv } from "lucide-react";
import type { UnifiCamerasReply } from "@church/shared";
import { usePoll } from "@/lib/use-poll";

/** UniFi Protect cameras, while reading them is switched on (Monitoring settings). Renders nothing when it is off. */
export function CamerasPanel() {
  const [reply, setReply] = useState<UnifiCamerasReply | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/v1/unifi/cameras", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setReply((await r.json()) as UnifiCamerasReply);
  }, []);
  usePoll(load, 30_000);

  if (!reply?.enabled) return null;
  const offline = reply.cameras.filter((c) => !c.online).length;
  return (
    <section className="mt-6 rounded-md border border-slate-300 p-4 dark:border-slate-800" aria-labelledby="cameras-heading">
      <h2 id="cameras-heading" className="flex items-center gap-2 text-sm font-semibold">
        <Cctv className="h-4 w-4" aria-hidden /> Cameras (UniFi Protect)
        <span className="font-normal text-slate-500 dark:text-slate-400">
          {reply.cameras.length} camera{reply.cameras.length === 1 ? "" : "s"}
          {offline ? `, ${offline} not connected` : ""}
        </span>
      </h2>
      {reply.error ? <p className="mt-2 text-sm text-rose-700 dark:text-rose-300">{reply.error}</p> : null}
      {reply.cameras.length ? (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {reply.cameras.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded border border-slate-200 px-3 py-2 text-sm dark:border-slate-800">
              <span className={`h-2 w-2 shrink-0 rounded-full ${c.online ? "bg-emerald-500" : "bg-rose-500"}`} aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
              <span className={`text-xs ${c.online ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>
                {c.online ? "Connected" : c.state.toLowerCase().replace(/_/g, " ")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
