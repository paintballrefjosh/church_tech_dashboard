import Link from "next/link";
import { Cross } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { ThemeToggle } from "./theme-toggle";
import { SearchBar } from "./search-bar";
import { TopBarNav } from "./topbar-nav";
import { UserMenu } from "./user-menu";
import { CommandPalette } from "./command-palette";

interface MePayload {
  access?: Record<string, "user" | "moderator" | "admin">;
}

interface SiteIdentity {
  name: string;
  tagline: string;
}

export async function TopBar() {
  const session = await auth();
  // Fetch the user's module-access map server-side so we can hide top-bar
  // links the user can't use. Cheap (one DB read) and avoids a per-page
  // client-side fetch from every layout. Site identity comes from the
  // settings table via a public endpoint so the brand updates the moment
  // an admin saves a new value at /admin/settings/site.
  let access: Record<string, "user" | "moderator" | "admin"> = {};
  if (session?.user) {
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
      className="relative z-30 border-b border-slate-300 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            <Cross className="h-5 w-5 text-brand-600" aria-hidden />
            {identity.name}
          </Link>
          {session?.user ? <TopBarNav access={access} /> : null}
        </div>
        <nav className="flex items-center gap-3 text-sm">
          {session?.user ? (
            <>
              <SearchBar />
              {/* Mounts the global Cmd+K palette. It opens itself on the
                  keystroke and is invisible otherwise. */}
              <CommandPalette />
              {/* Profile / notifications / theme / sign-out all live inside
                  the UserMenu now — keeps the right-hand side to two
                  controls instead of five. */}
              <UserMenu email={session.user.email ?? ""} />
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
