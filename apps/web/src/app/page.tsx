import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { DashboardBackdrop } from "@/components/dashboard-backdrop";
import type { DashboardInitialData } from "./dashboard-tiles/dashboard-grid";
import { HomeRoot } from "./home/home-root";
import { emptySnapshot } from "./home/empty-snapshot";
import {
  DASHBOARD_LOOKS,
  DEFAULT_DASHBOARD_LAYOUT,
  LOOK_DEVICE_COOKIE,
  resolveLook,
  type HomeSnapshot,
  type LookId,
  type Note,
  type Ticket,
  type TilePlacement,
  type WikiPage,
} from "@church/shared";

export const dynamic = "force-dynamic";

interface PrefsPayload {
  theme: LookId | null;
  siteDefault: LookId;
  enabled: LookId[];
  available: LookId[];
}

// Used when the prefs endpoint fails: the grid everyone already knows, plus the always-allowed start page.
const FALLBACK_PREFS: PrefsPayload = {
  theme: null,
  siteDefault: "tiles",
  enabled: ["tiles", "start"],
  available: ["tiles", "start"],
};

function first(v: string | string[] | undefined): string | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const urlTheme = first(query.theme);
  const kioskParam = first(query.kiosk);
  const kiosk = kioskParam === "1" || kioskParam === "true";

  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }

  // Resolve who this is BEFORE fetching any module data. A pending (awaiting
  // approval) account goes to /pending; an account with no module access at
  // all gets a "no access yet" message instead of an empty dashboard shell.
  // /me is read fresh from the DB so this is correct even on the very first
  // sign-in (before the session JWT reflects the provisioning decision).
  const me = await apiJson<{
    id?: string;
    name?: string | null;
    email?: string;
    permissions?: string[];
    access: Record<string, "user" | "moderator" | "admin">;
    approvalStatus?: "approved" | "pending";
  }>("/api/v1/me").catch(() => null);

  if (me?.approvalStatus === "pending") redirect("/pending");

  const access = me?.access ?? {};
  if (Object.keys(access).length === 0) {
    return (
      <>
        <TopBar />
        <DashboardBackdrop />
        <main className="fx-surface mx-auto max-w-2xl px-4 py-16">
          <div className="rounded-lg border border-slate-300 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900">
            <h1 className="text-lg font-semibold">No access yet</h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Your account doesn&apos;t have access to any modules yet. If you just signed in for
              the first time, an administrator needs to grant you access before you can use the
              dashboard. Please check back later.
            </p>
          </div>
        </main>
      </>
    );
  }

  const [prefs, cookieStore] = await Promise.all([
    apiJson<PrefsPayload>("/api/v1/dashboard/prefs").catch(() => FALLBACK_PREFS),
    cookies(),
  ]);
  const permissions = me?.permissions ?? [];
  const resolved = resolveLook({
    urlParam: urlTheme,
    deviceCookie: cookieStore.get(LOOK_DEVICE_COOKIE)?.value ?? null,
    userPref: prefs.theme,
    siteDefault: prefs.siteDefault,
    enabled: prefs.enabled,
    permissions,
  });
  let look = resolved.look;

  // Every other look reads the snapshot; a failed snapshot falls back to the tile grid, not an error page.
  let snapshot: HomeSnapshot | null = null;
  if (look !== "tiles") {
    const includes = DASHBOARD_LOOKS.find((l) => l.id === look)?.includes ?? [];
    const qs = includes.length > 0 ? `?include=${includes.join(",")}` : "";
    snapshot = await apiJson<HomeSnapshot>(`/api/v1/dashboard/home${qs}`).catch(() => null);
    if (!snapshot) look = "tiles";
  }

  let tiles: { layout: TilePlacement[]; initialData: DashboardInitialData } | undefined;
  if (look === "tiles") {
    // Pre-fetch the rarely-refreshed tile data alongside the layout so the
    // dashboard renders fully-populated on first paint — no per-tile
    // "Loading…" flash after hydration. The monitor / Planning Center tiles
    // keep their own client-side polling because their data changes second by
    // second; the slow-moving ones (tickets / notes / wiki) get static initial
    // payloads here.
    const [{ layout }, tickets, notes, wikiPages] = await Promise.all([
      apiJson<{ layout: TilePlacement[] }>("/api/v1/dashboard/layout").catch(() => ({
        layout: DEFAULT_DASHBOARD_LAYOUT,
      })),
      apiJson<Ticket[]>("/api/v1/tickets?scope=own&limit=20").catch(() => [] as Ticket[]),
      apiJson<Note[]>("/api/v1/notes").catch(() => [] as Note[]),
      apiJson<WikiPage[]>("/api/v1/wiki").catch(() => [] as WikiPage[]),
    ]);
    tiles = { layout, initialData: { tickets, notes, wikiPages } };
  }

  const appearance = look === "nave" ? "overlay" : look === "front-of-house" ? "console" : "default";

  return (
    <>
      <TopBar appearance={appearance} kiosk={kiosk} />
      {look === "tiles" ? <DashboardBackdrop /> : null}
      <HomeRoot
        look={look}
        source={look === resolved.look ? resolved.source : "fallback"}
        available={prefs.available}
        siteDefault={prefs.siteDefault}
        snapshot={snapshot ?? emptySnapshot()}
        me={{ id: me?.id ?? "", name: me?.name ?? me?.email ?? "", access, permissions }}
        kiosk={kiosk}
        tiles={tiles}
      />
    </>
  );
}
