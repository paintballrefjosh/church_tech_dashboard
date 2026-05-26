/**
 * Catalogue of known DB-stored settings. Anything the operator can change at
 * runtime (without editing files) goes here. Future Phase 1+ wiring reads
 * values from the `settings` table using these keys.
 *
 * Truly bootstrap-time things — DB URL, Redis URL, AUTH_SECRET — stay in env
 * because they're needed before the DB is reachable. Everything else lives here.
 */

import { z } from "zod";

export type SettingType = "string" | "boolean" | "number" | "secret" | "json";

export interface KnownSetting<T = unknown> {
  key: string;
  type: SettingType;
  label: string;
  description: string;
  defaultValue: T;
  category: "site" | "auth" | "google" | "smtp" | "experimental";
}

export const KNOWN_SETTINGS: ReadonlyArray<KnownSetting> = [
  // Site
  {
    key: "site.name",
    type: "string",
    label: "Site name",
    description: "Shown in the page title and emails.",
    defaultValue: "Church Dashboard",
    category: "site",
  },
  {
    key: "site.tagline",
    type: "string",
    label: "Tagline",
    description: "Shown under the site name on sign-in.",
    defaultValue: "",
    category: "site",
  },
  // Auth
  {
    key: "auth.local.enabled",
    type: "boolean",
    label: "Allow local sign-in",
    description: "If off, only Google sign-in works.",
    defaultValue: true,
    category: "auth",
  },
  {
    key: "auth.require_totp_all",
    type: "boolean",
    label: "Require 2FA for all users",
    description: "Admins always require 2FA; this extends it to everyone.",
    defaultValue: false,
    category: "auth",
  },
  // Google Workspace
  {
    key: "google.oauth.client_id",
    type: "string",
    label: "Google OAuth Client ID",
    description: "From Google Cloud Console — Web application.",
    defaultValue: "",
    category: "google",
  },
  {
    key: "google.oauth.client_secret",
    type: "secret",
    label: "Google OAuth Client Secret",
    description: "Paired with the client ID.",
    defaultValue: "",
    category: "google",
  },
  {
    key: "google.workspace_domain",
    type: "string",
    label: "Workspace domain",
    description: "Restrict sign-in to this domain only (e.g. mychurch.org).",
    defaultValue: "",
    category: "google",
  },
  // SMTP
  {
    key: "smtp.host",
    type: "string",
    label: "SMTP host",
    description: "Hostname of the outbound mail server.",
    defaultValue: "mailhog",
    category: "smtp",
  },
  {
    key: "smtp.port",
    type: "number",
    label: "SMTP port",
    description: "Usually 587 for TLS, 25 for plain.",
    defaultValue: 1025,
    category: "smtp",
  },
  {
    key: "smtp.username",
    type: "string",
    label: "SMTP username",
    description: "If your SMTP server requires authentication.",
    defaultValue: "",
    category: "smtp",
  },
  {
    key: "smtp.password",
    type: "secret",
    label: "SMTP password",
    description: "Paired with the username.",
    defaultValue: "",
    category: "smtp",
  },
  {
    key: "smtp.from_email",
    type: "string",
    label: "From address",
    description: "All outbound mail uses this as the From: address.",
    defaultValue: "noreply@church.local",
    category: "smtp",
  },
  {
    key: "smtp.from_name",
    type: "string",
    label: "From name",
    description: "Display name on outbound mail.",
    defaultValue: "Church Dashboard",
    category: "smtp",
  },
  {
    key: "smtp.secure",
    type: "boolean",
    label: "Use TLS",
    description: "True for implicit TLS on port 465; false otherwise.",
    defaultValue: false,
    category: "smtp",
  },
] as const;

export const settingKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9._-]{0,127}$/, "lowercase, digits, dot, underscore, dash; must start with a letter");

export function findKnownSetting(key: string): KnownSetting | undefined {
  return KNOWN_SETTINGS.find((s) => s.key === key);
}
