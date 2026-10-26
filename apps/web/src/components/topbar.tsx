import Link from "next/link";
import { Cross } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { ThemeToggle } from "./theme-toggle";
import { SearchBar } from "./search-bar";
import { TopBarNav } from "./topbar-nav";
import { UserMenu } from "./user-menu";
import { CommandPalette } from "./command-palette";
import { AssistantPanel } from "./assistant-panel";

interface MePayload {
  access?: Record<string, "user" | "moderator" | "admin">;
}

interface SiteIdentity {
  name: string;
  tagline: string;
}

export type TopBarAppearance = "default" | "overlay" | "console";

const APPEARANCE_CLASSES: Record<TopBarAppearance, string> = {
  default: "border-b border-slate-300 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80",
  // Transparent with no rule, for a hero image or artwork sitting underneath.
  overlay: "border-b border-transparent bg-transparent",
  // A neutral grey bar: light grey in light mode, dark grey in dark mode.
  console: "border-b border-slate-300 bg-slate-200 dark:border-slate-700 dark:bg-slate-800",
};

export async function TopBar({
  appearance = "default",
  kiosk = false,
}: {
  appearance?: TopBarAppearance;
  /** A booth screen: no navigation, search or command palette. Brand and user menu stay. */
  kiosk?: boolean;
} = {}) {
  const session = await auth();
  // Fetch the user's module-access map server-side so we can hide top-bar
  // links the user can't use. Cheap (one DB read) and avoids a per-page
  // client-side fetch from every layout. Site identity comes from the
  // settings table via a public endpoint so the brand updates the moment
  // an admin saves a new value at /admin/settings/site.
  let access: Record<string, "user" | "moderator" | "admin"> = {};
  if (session?.user && !kiosk) {
    const me = await apiJson<MePayload>("/api/v1/me").catch(() => null);
    access = me?.access ?? {};
  }
  const identity =
    (await apiJson<SiteIdentity>("/api/v1/site/identity").catch(() => null)) ?? {
      name: "Church Dashboard",
      tagline: "",
    };
  return (
    <header
      // `relative z-30` gives the header its own stacking context, sitting
      // above react-grid-layout's transformed dashboard tiles. Without this
      // UserMenu / NavDropdown panels render *below* tiles on the dashboard
      // because each tile creates its own stacking context via `transform`.
      className={`relative z-30 ${APPEARANCE_CLASSES[appearance]}`}
      data-appearance={appearance}
    >
      {/* One wrapping row. Phones: brand and the user menu, then the nav, then search, each on
          its own line. sm: search moves up beside the user menu. md and up: brand, nav, then
          search and the user menu on the right, as before. */}
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link
          href="/"
          className="order-1 flex min-w-0 items-center gap-2 text-base font-semibold tracking-tight"
        >
          <Cross className="h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400" aria-hidden />
          <span className="truncate">{identity.name}</span>
        </Link>
        {session?.user && !kiosk ? (
          <div className="order-3 w-full sm:order-4 md:order-2 md:w-auto">
            <TopBarNav access={access} />
          </div>
        ) : null}
        {session?.user && !kiosk ? (
          <div className="order-4 w-full sm:order-2 sm:ml-auto sm:w-auto md:order-3">
            <SearchBar />
          </div>
        ) : null}
        <nav aria-label="Account" className="order-2 ml-auto flex items-center gap-3 text-sm sm:order-3 sm:ml-0 md:order-4">
          {session?.user ? (
            <>
              {/* Mounts the global Cmd+K palette. It opens itself on the
                  keystroke and is invisible otherwise. */}
              {kiosk ? null : <CommandPalette access={access} />}
              {kiosk ? null : <AssistantPanel access={access} />}
              {/* Profile / notifications / theme / sign-out all live inside
                  the UserMenu now — keeps the right-hand side to two
                  controls instead of five. */}
              <UserMenu email={session.user.email ?? ""} assistant={!kiosk && "assistant" in access} />
            </>
          ) : (
            <>
              {/* Signed-out users still need a theme toggle (sign-in page
                  doesn't render TopBar, but other public pages would). */}
              <ThemeToggle />
              <Link
                href="/signin"
                className="rounded-md bg-brand-600 px-3 py-1.5 text-white hover:bg-brand-700"
              >
                Sign in
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
