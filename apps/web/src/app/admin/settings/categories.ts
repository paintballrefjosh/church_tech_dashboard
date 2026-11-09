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
  FlaskConical,
  DatabaseBackup,
  Settings as SettingsIcon,
} from "lucide-react";

export interface CategoryMeta {
  slug: string;
  label: string;
  description: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  /**
   * Permission that lets a user reach this category. The hub page hides
   * categories the current user lacks the permission for. Every category here
   * is site-wide; a module's own settings live on the module's Settings page.
   */
  permission: string;
}

export const SETTINGS_CATEGORIES: CategoryMeta[] = [
  {
    slug: "site",
    label: "Site",
    description: "Site name, tagline, and other public-facing identity.",
    Icon: Globe,
    permission: "site:read",
  },
  {
    slug: "auth",
    label: "Authentication",
    description: "Local sign-in policy, password requirements, 2FA, and the API rate limit.",
    Icon: KeyRound,
    permission: "site:read",
  },
  {
    slug: "google",
    label: "Google OAuth",
    description: "Google sign-in client id + secret.",
    Icon: Cloud,
    permission: "site:read",
  },
  {
    slug: "microsoft",
    label: "Microsoft OAuth",
    description: "Microsoft Entra ID / personal account sign-in.",
    Icon: KeyRound,
    permission: "site:read",
  },
  {
    slug: "smtp",
    label: "SMTP",
    description: "Outbound mail server, from address, TLS.",
    Icon: Mail,
    permission: "site:read",
  },
  {
    slug: "backup",
    label: "Backups",
    description: "Offsite copies: a second bucket that scheduled backups are copied to.",
    Icon: DatabaseBackup,
    permission: "site:read",
  },
  {
    slug: "experimental",
    label: "Experimental",
    description: "Flags for unreleased features. Don't enable in production.",
    Icon: FlaskConical,
    permission: "site:read",
  },
];

export const DEFAULT_CATEGORY_ICON = SettingsIcon;

export function findCategory(slug: string): CategoryMeta | undefined {
  return SETTINGS_CATEGORIES.find((c) => c.slug === slug);
}
