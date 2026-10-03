import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Shield,
  Globe,
  Mail,
  Cloud,
  KeyRound,
  ScrollText,
  Tags,
  Folder,
  CalendarDays,
  ListChecks,
  UsersRound,
  Users,
  Printer,
  Server,
  Presentation,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { ReindexButton } from "./reindex-button";

interface MePayload {
  permissions?: string[];
}

type AdminSection = "admin" | "reporting" | "modules";

interface AdminCard {
  href: string;
  label: string;
  Icon: typeof Shield;
  description: React.ReactNode;
  section: AdminSection;
  /** Permission required to see this card. Cards with no perm always show. */
  perm?: string;
}

const CARDS: AdminCard[] = [
  // ── Admin: site administration ──────────────────────────────────────────
  {
    href: "/admin/settings/site",
    label: "Site settings",
    Icon: Globe,
    description: "Site name, tagline, footer, SLA targets, and audit retention.",
    section: "admin",
    perm: "site:read",
  },
  {
    href: "/admin/users",
    label: "Users",
    Icon: UsersRound,
    description: "Every local + OAuth-provisioned account. Edit display name, active state, and group memberships.",
    section: "admin",
    perm: "user:read",
  },
  {
    href: "/admin/groups",
    label: "Groups",
    Icon: Users,
    description: "Bundle users and grant each group a tier per module. Members inherit the group's access.",
    section: "admin",
    perm: "user:read",
  },
  {
    href: "/admin/tags",
    label: "Tags",
    Icon: Tags,
    description: "Manage the tag catalogue — names + colours used across tickets, notes, and wiki pages.",
    section: "admin",
    perm: "tags:write:any",
  },
  {
    href: "/admin/settings/smtp",
    label: "SMTP",
    Icon: Mail,
    description: "Outbound mail server, from address, and TLS for notifications and welcome emails.",
    section: "admin",
    perm: "site:read",
  },
  {
    href: "/admin/settings/google",
    label: "Google OAuth",
    Icon: Cloud,
    description: "Google sign-in client id + secret, workspace domain, and external-account approval.",
    section: "admin",
    perm: "site:read",
  },
  {
    href: "/admin/settings/microsoft",
    label: "Microsoft OAuth",
    Icon: KeyRound,
    description: "Microsoft Entra ID sign-in client id + secret, tenant, and allowed domains.",
    section: "admin",
    perm: "site:read",
  },
  {
    href: "/admin/settings/auth",
    label: "Auth settings",
    Icon: KeyRound,
    description: "Local sign-in policy and the 2FA (TOTP) enrolment requirements.",
    section: "admin",
    perm: "site:read",
  },

  // ── Reporting ─────────────────────────────────────────────────────────────
  {
    href: "/admin/permissions",
    label: "Permission matrix",
    Icon: KeyRound,
    description: "Read-only view of every module × group access tier.",
    section: "reporting",
    perm: "permissions:read:any",
  },
  {
    href: "/admin/audit",
    label: "Audit log",
    Icon: ScrollText,
    description: "Every mutating action recorded by the API — actor, IP, before/after diff. Filterable.",
    section: "reporting",
    perm: "audit:read:any",
  },

  // ── Modules: per-module admin surfaces (visible to that module's admins) ──
  {
    href: "/admin/ticket-categories",
    label: "Helpdesk categories",
    Icon: Folder,
    description: "Admin-curated multi-select shown on every ticket.",
    section: "modules",
    perm: "tickets:categories:admin",
  },
  {
    href: "/admin/settings/printers",
    label: "Printers settings",
    Icon: Printer,
    description: "Default SNMP community + polling cadence for the Printers module.",
    section: "modules",
    perm: "printers:admin",
  },
  {
    href: "/admin/settings/monitoring",
    label: "Monitoring & Network settings",
    Icon: Server,
    description: "Collector cadence + concurrency, and the UniFi controller URL and API key.",
    section: "modules",
    perm: "monitors:write:any",
  },
  {
    href: "/admin/settings/propresenter",
    label: "ProPresenter settings",
    Icon: Presentation,
    description: "Host, port, and remote password for PP7 control.",
    section: "modules",
    perm: "propresenter:admin",
  },
  {
    href: "/admin/settings/planning_center",
    label: "Planning Center settings",
    Icon: CalendarDays,
    description: "App id + secret and the default service type for Planning Center Services.",
    section: "modules",
    perm: "planning_center:admin",
  },
  {
    href: "/admin/planning-center",
    label: "Planning Center links",
    Icon: CalendarDays,
    description: "Map local users to Planning Center people so service assignments highlight known users.",
    section: "modules",
    perm: "planning_center:admin",
  },
  {
    href: "/admin/checklists",
    label: "Checklists",
    Icon: ListChecks,
    description: "Manage checklist templates, events, and view completion reports for volunteers.",
    section: "modules",
    perm: "checklists:admin",
  },
];

const SECTIONS: Array<{ key: AdminSection; title: string; blurb: string }> = [
  { key: "admin", title: "Admin", blurb: "Site configuration, accounts, and access." },
  { key: "reporting", title: "Reporting", blurb: "Read-only views into access and activity." },
  {
    key: "modules",
    title: "Modules",
    blurb: "Settings for the modules you administer. Only modules you're an admin of appear here.",
  },
];

// Shared chrome for the landing sections. Each section is a tinted box that sits
// just off the page background; the cards inside sit a shade lighter again so
// they read as raised tiles. Headers are a lighter brand blue and a touch larger
// than the surrounding body text so the sections are easy to scan.
// The section box is just an outline that matches the page background; the
// cards inside are the only filled surface, sitting a shade off the page so
// they read as raised tiles.
//   light:  page white      -> card slate-50
//   dark:   page slate-950  -> card slate-900
const SECTION_BOX =
  "mt-6 rounded-lg border border-slate-300 p-5 dark:border-slate-700";
const SECTION_HEADER =
  "text-base font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400";
const CARD_BOX =
  "rounded-md border border-slate-300 bg-slate-50 p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900";

export default async function AdminHome() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const me = await apiJson<MePayload>("/api/v1/me").catch(() => null);
  const perms = new Set(me?.permissions ?? []);
  const visible = CARDS.filter((c) => !c.perm || perms.has(c.perm));

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={Shield}>Admin</PageTitle>
        {visible.length === 0 ? (
          <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            You don't have permission to manage anything in this section. Ask an admin to grant
            you the relevant module <code className="font-mono">admin</code> tier.
          </p>
        ) : (
          SECTIONS.map((s) => {
            const cards = visible.filter((c) => c.section === s.key);
            if (cards.length === 0) return null;
            return (
              <section key={s.key} className={SECTION_BOX}>
                <h2 className={SECTION_HEADER}>{s.title}</h2>
                <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{s.blurb}</p>
                <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                  {cards.map((c) => (
                    <li key={c.href} className={CARD_BOX}>
                      <Link
                        href={c.href}
                        className="inline-flex items-center gap-2 text-base font-medium text-brand-600 hover:underline dark:text-brand-400"
                      >
                        <c.Icon className="h-4 w-4" aria-hidden /> {c.label}
                      </Link>
                      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{c.description}</p>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}

        {perms.has("site:admin") ? (
          <section className={SECTION_BOX}>
            <h2 className={`mb-3 ${SECTION_HEADER}`}>Maintenance</h2>
            <ReindexButton />
          </section>
        ) : null}
      </main>
    </>
  );
}
