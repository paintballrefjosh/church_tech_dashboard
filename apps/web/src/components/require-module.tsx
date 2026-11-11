import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { MODULES } from "@lampstand/shared";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";

interface MePayload {
  access?: Record<string, "user" | "moderator" | "admin">;
}

/**
 * The page-level door for a module's section. Put it in the section's layout, around everything the layout renders.
 *
 * The API already refuses the data (every route checks a permission string), but a page shell that swallows the 403
 * still drew itself, so a person without the module could open /monitoring, /livestreams and the rest by typing the
 * address. The top-bar menus hide those links by the same rule: any tier on the module is enough
 * (`module in access`, as in `topbar-nav.tsx`).
 *
 * If /me cannot be read the section is NOT blocked here (the API's own answers still stop the data), so an API outage
 * does not turn into a wall of "no access" pages.
 */
export async function RequireModule({ module, children }: { module: string; children: ReactNode }) {
  const me = await apiJson<MePayload>("/api/v1/me").catch(() => null);
  if (me && !(module in (me.access ?? {}))) return <NoAccess module={module} />;
  return <>{children}</>;
}

async function NoAccess({ module }: { module: string }) {
  const label = MODULES.find((m) => m.key === module)?.label ?? module;
  return (
    <>
      <TopBar />
      <main id="main" className="mx-auto max-w-2xl px-4 py-16">
        <div role="alert" className="rounded-lg border border-slate-300 bg-white p-6 dark:border-slate-700 dark:bg-slate-900">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
            <ShieldAlert className="h-5 w-5 text-amber-700 dark:text-amber-400" aria-hidden /> No access
          </h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Your groups do not include {label}. If you need it, ask a site administrator to add it to one of your groups.
          </p>
        </div>
      </main>
    </>
  );
}
