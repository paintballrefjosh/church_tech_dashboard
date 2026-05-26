import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { apiJson } from "@/lib/api";
import { KNOWN_SETTINGS } from "@church/shared";
import { SettingsForm } from "./settings-form";

interface SettingsListResponse {
  items: Array<{ key: string; value: unknown }>;
}

export default async function AdminSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  let current: Record<string, unknown> = {};
  try {
    const res = await apiJson<SettingsListResponse>("/api/v1/settings");
    current = Object.fromEntries(res.items.map((i) => [i.key, i.value]));
  } catch (err) {
    return (
      <>
        <TopBar />
        <main className="mx-auto max-w-3xl px-4 py-10">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="mt-4 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            Cannot load settings ({(err as Error).message}). You need the
            <code className="mx-1">settings:read:any</code> permission (admin role).
          </p>
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          All values are stored in the database. Changes take effect immediately for any feature that reads them.
        </p>
        <SettingsForm
          known={KNOWN_SETTINGS.map((s) => ({
            key: s.key,
            type: s.type,
            label: s.label,
            description: s.description,
            defaultValue: s.defaultValue,
            category: s.category,
          }))}
          current={current}
        />
      </main>
    </>
  );
}
