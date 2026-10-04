"use client";

import {
  LifeBuoy,
  StickyNote,
  BookOpen,
  Activity,
  Server,
  Presentation,
  CalendarDays,
  Printer,
  Wrench,
  Church,
  Shield,
  Globe,
  Cloud,
  Mail,
  KeyRound,
  UsersRound,
  FileText,
  ListChecks,
  Tags,
  ScrollText,
  Folder,
  Boxes,
} from "lucide-react";
import { NavDropdown, type NavDropdownItem, type NavDropdownEntry } from "./nav-dropdown";

/**
 * Client-side topbar nav. Each nav item is gated on the user's tier for a
 * given module — any tier is enough to surface the link. The Admin dropdown
 * shows for full site admins (`access.admin === "admin"`) and for module
 * admins (`access[module] === "admin"`); module admins see only Admin home
 * plus the settings links for the module(s) they administer.
 *
 * Lives in its own client component because NavDropdown takes lucide icon
 * components as props; passing those from a server component would cross
 * the server/client boundary.
 */

interface Item extends NavDropdownItem {
  /** Module key — any tier in user.access[module] is enough to render. */
  module?: string;
}

const IT_ITEMS: Item[] = [
  { href: "/tickets", label: "Help Desk", Icon: LifeBuoy, module: "tickets" },
  { href: "/printers", label: "Printers", Icon: Printer, module: "printers" },
  // Services, Infrastructure, and Network are tabs within the Monitoring
  // section now — one nav entry leads to all three.
  { href: "/monitoring", label: "Monitoring", Icon: Activity, module: "monitoring" },
  // IPAM and DNS ride the monitoring module's permissions but are their own pages.
  { href: "/ipam", label: "IPAM", Icon: Boxes, module: "monitoring" },
  { href: "/dns", label: "DNS", Icon: Globe, module: "monitoring" },
];

const DOCS_ITEMS: Item[] = [
  { href: "/notes", label: "Notes", Icon: StickyNote, module: "notes" },
  { href: "/wiki", label: "Wiki", Icon: BookOpen, module: "wiki" },
];

const CHURCH_APPS_ITEMS: Item[] = [
  { href: "/propresenter", label: "ProPresenter", Icon: Presentation, module: "propresenter" },
  {
    href: "/planning-center",
    label: "Planning Center Services",
    Icon: CalendarDays,
    module: "planning_center",
  },
  { href: "/checklists", label: "Checklists", Icon: ListChecks, module: "checklists" },
];

// Shown only to full site admins (access.admin === "admin"). Split into the
// same sections as the /admin landing page so the dropdown reads as grouped
// rather than one long list.
const SITE_ADMIN_CORE: NavDropdownItem[] = [
  { href: "/admin/users", label: "Users", Icon: UsersRound },
  { href: "/admin/groups", label: "Groups", Icon: UsersRound },
  { href: "/admin/tags", label: "Tags", Icon: Tags },
  { href: "/admin/settings/site", label: "Site settings", Icon: Globe },
  { href: "/admin/settings/auth", label: "Auth settings", Icon: KeyRound },
  { href: "/admin/settings/smtp", label: "SMTP settings", Icon: Mail },
  { href: "/admin/settings/google", label: "Google OAuth", Icon: Cloud },
  { href: "/admin/settings/microsoft", label: "Microsoft OAuth", Icon: KeyRound },
];
const SITE_ADMIN_REPORTING: NavDropdownItem[] = [
  { href: "/admin/permissions", label: "Permission matrix", Icon: KeyRound },
  { href: "/admin/audit", label: "Audit log", Icon: ScrollText },
];

// Per-module admin links, keyed by module key. A user with that module at the
// "admin" tier sees these even without being a full site admin.
const MODULE_ADMIN_ITEMS: Record<string, NavDropdownItem[]> = {
  tickets: [{ href: "/admin/ticket-categories", label: "Helpdesk categories", Icon: Folder }],
  printers: [{ href: "/admin/settings/printers", label: "Printers settings", Icon: Printer }],
  monitoring: [
    { href: "/admin/settings/monitoring", label: "Monitoring & Network settings", Icon: Server },
  ],
  propresenter: [{ href: "/admin/settings/propresenter", label: "ProPresenter settings", Icon: Presentation }],
  planning_center: [
    { href: "/admin/settings/planning_center", label: "Planning Center settings", Icon: CalendarDays },
    { href: "/admin/planning-center", label: "Planning Center links", Icon: CalendarDays },
  ],
  checklists: [{ href: "/admin/checklists", label: "Checklists", Icon: ListChecks }],
};

function filterByAccess(items: Item[], access: Record<string, string>): NavDropdownItem[] {
  return items
    .filter((i) => !i.module || i.module in access || i.disabled)
    .map(({ module: _m, ...rest }) => rest);
}

/**
 * Compose the Administration dropdown for this user, grouped under section
 * headers. Site admins get the Administration + Reporting groups; module admins
 * (with or without site admin) get a Modules group of just the module(s) they
 * administer. "Admin home" always leads when the dropdown shows at all.
 */
function buildAdminItems(access: Record<string, string>): NavDropdownEntry[] {
  const isSiteAdmin = access.admin === "admin";
  const moduleKeys = Object.keys(MODULE_ADMIN_ITEMS).filter((k) => access[k] === "admin");
  if (!isSiteAdmin && moduleKeys.length === 0) return [];

  const entries: NavDropdownEntry[] = [{ href: "/admin", label: "Admin home", Icon: Shield }];
  if (isSiteAdmin) {
    entries.push(
      { header: "Administration" },
      ...SITE_ADMIN_CORE,
      { header: "Reporting" },
      ...SITE_ADMIN_REPORTING,
    );
  }
  if (moduleKeys.length > 0) {
    entries.push({ header: "Modules" });
    for (const k of moduleKeys) entries.push(...(MODULE_ADMIN_ITEMS[k] ?? []));
  }
  return entries;
}

export function TopBarNav({ access }: { access: Record<string, "user" | "moderator" | "admin"> }) {
  const itItems = filterByAccess(IT_ITEMS, access);
  const docsItems = filterByAccess(DOCS_ITEMS, access);
  const churchItems = filterByAccess(CHURCH_APPS_ITEMS, access);
  const adminItems = buildAdminItems(access);

  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm">
      {itItems.length > 0 ? (
        <NavDropdown label="IT" Icon={Wrench} items={itItems} />
      ) : null}
      {docsItems.length > 0 ? (
        <NavDropdown label="Docs" Icon={FileText} items={docsItems} />
      ) : null}
      {churchItems.length > 0 ? (
        <NavDropdown label="Church Apps" Icon={Church} items={churchItems} />
      ) : null}
      {adminItems.length > 0 ? (
        <NavDropdown label="Administration" Icon={Shield} items={adminItems} tone="accent" />
      ) : null}
    </nav>
  );
}
