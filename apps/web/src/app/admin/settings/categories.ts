/**
 * UI-side metadata for KNOWN_SETTINGS categories. The category string itself
 * lives on the shared schema; this only adds the display label, icon, and
 * a one-line description for the hub page. Keep in sync as new categories
 * are added on the backend.
 */
import type { ComponentType } from "react";
import {
  Globe,
  KeyRound,
  Cloud,
  Mail,
  Printer,
  Presentation,
  CalendarDays,
  Server,
  FlaskConical,
  Settings as SettingsIcon,
} from "lucide-react";

export interface CategoryMeta {
  slug: string;
  label: string;
  description: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /**
   * "core" = site administration (only site admins manage it); "module" = a
   * module's integration settings, manageable by that module's admin.
   */
  section: "core" | "module";
  /**
   * Permission that lets a user reach this category. Core categories use a
   * site-admin perm; module categories use the module's `:admin` perm so a
   * module admin can manage them without being a site admin. The hub page hides
   * categories the current user lacks the permission for.
   */
  permission: string;
}

export const SETTINGS_CATEGORIES: CategoryMeta[] = [
  {
    slug: "site",
    label: "Site",
    description: "Site name, tagline, and other public-facing identity.",
    Icon: Globe,
    section: "core",
    permission: "site:read",
  },
  {
    slug: "auth",
    label: "Authentication",
    description: "Local sign-in policy and password requirements.",
    Icon: KeyRound,
    section: "core",
    permission: "site:read",
  },
  {
    slug: "google",
    label: "Google OAuth",
    description: "Google sign-in client id + secret.",
    Icon: Cloud,
    section: "core",
    permission: "site:read",
  },
  {
    slug: "microsoft",
    label: "Microsoft OAuth",
    description: "Microsoft Entra ID / personal account sign-in.",
    Icon: KeyRound,
    section: "core",
    permission: "site:read",
  },
  {
    slug: "smtp",
    label: "SMTP",
    description: "Outbound mail server, from address, TLS.",
    Icon: Mail,
    section: "core",
    permission: "site:read",
  },
  {
    slug: "printers",
    label: "Printers",
    description: "Default SNMP community + polling cadence for the Printers module.",
    Icon: Printer,
    section: "module",
    permission: "printers:admin",
  },
  {
    slug: "propresenter",
    label: "ProPresenter",
    description: "Host, port, and remote password for PP7 control.",
    Icon: Presentation,
    section: "module",
    permission: "propresenter:admin",
  },
  {
    slug: "planning_center",
    label: "Planning Center",
    description: "App id + secret and default service type for services.",
    Icon: CalendarDays,
    section: "module",
    permission: "planning_center:admin",
  },
  {
    slug: "monitoring",
    label: "Monitoring & Network",
    description: "Collector tick + concurrency, the UniFi controller, and the Technitium DNS primary.",
    Icon: Server,
    section: "module",
    permission: "monitors:write:any",
  },
  {
    slug: "experimental",
    label: "Experimental",
    description: "Flags for unreleased features. Don't enable in production.",
    Icon: FlaskConical,
    section: "core",
    permission: "site:read",
  },
];

export const DEFAULT_CATEGORY_ICON = SettingsIcon;

export function findCategory(slug: string): CategoryMeta | undefined {
  return SETTINGS_CATEGORIES.find((c) => c.slug === slug);
}
