import { notFound } from "next/navigation";
import { Radio } from "lucide-react";
import type { PublicStatusPage } from "@church/shared";
import { StatusClient } from "../status/status-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Status" };

const internal = process.env.API_INTERNAL_URL ?? "http://api:3001";

/**
 * The status page for people who are not signed in (the congregation, a visiting tech), published only while
 * `monitoring.status_public` is on; the API answers 404 otherwise, and so does this page. No top bar: it needs a session.
 */
export default async function PublicStatusRoute() {
  const [res, chrome] = await Promise.all([
    fetch(`${internal}/api/v1/status/public`, { cache: "no-store" }).catch(() => null),
    fetch(`${internal}/api/v1/settings/public`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ siteName?: string }>) : null))
      .catch(() => null),
  ]);
  if (!res || res.status === 404) notFound();
  const initial = res.ok ? ((await res.json()) as PublicStatusPage) : null;
  const site = chrome?.siteName?.trim() || "";

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Radio className="h-6 w-6" aria-hidden />
          {site ? `${site}: status` : "Status"}
        </h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          What is working right now. This updates by itself; if something here is down, the people who look after it have been told.
        </p>
      </header>
      <StatusClient initial={initial} source="/api/v1/status/public" />
    </main>
  );
}
