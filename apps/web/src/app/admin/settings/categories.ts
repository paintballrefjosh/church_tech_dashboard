/**
 * UI-side metadata for KNOWN_SETTINGS categories. The category string itself
 * lives on the shared schema; this only adds the display label, icon, and
 * a one-line description for the hub page. Keep in sync as new categories
 * are added on the backend.
 */
import type { ComponentType } from "react";
import {
  MonitorPlay,
  Globe,
  KeyRound,
  Cloud,
  Mail,
  Printer,
  Presentation,
  CalendarDays,
  Server,
  FlaskConical,
  DatabaseBackup,
  Inbox,
  Bot,
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
    description: "Local sign-in policy, password requirements, 2FA, and the API rate limit.",
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
    slug: "livestreams",
    label: "Livestreams",
    description: "Optional API keys for YouTube, Twitch, Facebook and Resi, and how many streams are sampled at once.",
    Icon: MonitorPlay,
    section: "module",
    permission: "livestreams:admin",
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
    slug: "backup",
    label: "Backups",
    description: "Offsite copies: a second bucket that scheduled backups are copied to.",
    Icon: DatabaseBackup,
    section: "core",
    permission: "site:read",
  },
  {
    slug: "helpdesk",
    label: "Helpdesk email",
    description: "A mailbox that turns email into tickets and ticket replies.",
    Icon: Inbox,
    section: "core",
    permission: "site:read",
  },
  {
    slug: "assistant",
    label: "Assistant",
    description: "An in-app chat over the wiki, tickets and live systems, answered by a model you choose. Off until set up.",
    Icon: Bot,
    section: "core",
    permission: "site:read",
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
