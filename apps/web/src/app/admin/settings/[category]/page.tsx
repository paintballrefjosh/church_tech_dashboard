import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import {
  DEFAULT_LOOK,
  KNOWN_SETTINGS,
  LOOK_IDS,
  isLookId,
  resolveAllowedAttachmentTypes,
  resolveCustomAttachmentExtensions,
  type LookId,
} from "@church/shared";
import { headers } from "next/headers";
import { SettingsForm } from "../settings-form";
import { findCategory } from "../categories";
import { OAuthCallbackHint } from "./oauth-callback-hint";
import { AssistantPanel } from "./assistant-panel";
import { HomePageSettings } from "./home-page-settings";
import { AttachmentSettings } from "./attachment-settings";
import { HelpdeskEmailPanel, type InboundStatus } from "./helpdesk-email-panel";

/** Shown by the Home page and Attachments sections on the Site page, so the generic form leaves them out. */
const HOME_PAGE_KEYS = new Set([
  "site.timezone",
  "dashboard.default_theme",
  "dashboard.enabled_themes",
  "dashboard.stream_monitor_ids",
  "attachments.allowed_types",
  "attachments.custom_extensions",
]);

/**
 * Compute the OAuth redirect URL the user needs to paste into Google/MS
 * Console. We don't know our public origin at build time (per CLAUDE.md
 * everything is dynamic), so derive it from the inbound headers:
 * X-Forwarded-Proto + X-Forwarded-Host (set by Caddy) → host + scheme.
 */
async function deriveCallbackUrl(provider: string): Promise<string> {
  const h = await headers();
  const proto = (h.get("x-forwarded-proto") ?? "http").split(",")[0]?.trim() ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  if (!host) return `/api/auth/callback/${provider}`;
  return `${proto}://${host}/api/auth/callback/${provider}`;
}

interface SettingsListResponse {
  items: Array<{ key: string; value: unknown }>;
}

export const dynamic = "force-dynamic";

export default async function AdminSettingsCategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const { category: slug } = await params;
  const meta = findCategory(slug);
  if (!meta) notFound();

  // Filter the catalogue down to just this category's settings. If there are
  // none we render the page with an empty-state message rather than 404 — the
  // category is real, just unused for this deployment.
  const scoped = KNOWN_SETTINGS.filter(
    (s) => s.category === slug && !(slug === "site" && HOME_PAGE_KEYS.has(s.key)),
  );

  let current: Record<string, unknown> = {};
  try {
    const res = await apiJson<SettingsListResponse>("/api/v1/settings");
    current = Object.fromEntries(res.items.map((i) => [i.key, i.value]));
  } catch (err) {
    return (
      <>
        <TopBar />
        <main className="mx-auto max-w-6xl px-4 py-10">
          <PageTitle icon={meta.Icon}>{meta.label}</PageTitle>
          <p className="mt-4 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            Cannot load settings ({(err as Error).message}). You don't have permission to manage
            these settings — ask an admin for the relevant module's <code className="mx-1">admin</code> tier.
          </p>
        </main>
      </>
    );
  }

  const rawEnabled = current["dashboard.enabled_themes"];
  const enabledThemes: LookId[] = Array.isArray(rawEnabled)
    ? LOOK_IDS.filter((id) => rawEnabled.includes(id))
    : [...LOOK_IDS];
  const rawStream = current["dashboard.stream_monitor_ids"];
  const streamMonitorIds = Array.isArray(rawStream)
    ? rawStream.filter((v): v is string => typeof v === "string")
    : [];
  // Only admins who can read monitors get the picker; the call fails for anyone else.
  const monitors =
    slug === "site"
      ? await apiJson<Array<{ id: string; name: string }>>("/api/v1/monitors")
          .then((rows) => rows.map((m) => ({ id: m.id, name: m.name })))
          .catch(() => null)
      : null;
  const defaultTheme = current["dashboard.default_theme"];
  const inboundStatus =
    slug === "helpdesk" ? await apiJson<InboundStatus>("/api/v1/tickets/inbound/status").catch(() => null) : null;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <nav aria-label="Breadcrumb" className="mb-3 text-sm">
          <Link
            href="/admin/settings"
            className="inline-flex items-center gap-1 text-brand-600 dark:text-brand-400 hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to all settings
          </Link>
        </nav>
        <PageTitle icon={meta.Icon}>{meta.label}</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{meta.description}</p>

        {slug === "google" ? (
          <OAuthCallbackHint
            provider="Google"
            callbackUrl={await deriveCallbackUrl("google")}
            consoleUrl="https://console.cloud.google.com/apis/credentials"
          />
        ) : null}
        {slug === "microsoft" ? (
          <OAuthCallbackHint
            provider="Microsoft"
            callbackUrl={await deriveCallbackUrl("microsoft-entra-id")}
            consoleUrl="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps"
          />
        ) : null}

        {slug === "site" ? (
          <HomePageSettings
            timezone={typeof current["site.timezone"] === "string" ? current["site.timezone"] : "UTC"}
            defaultTheme={isLookId(defaultTheme) ? defaultTheme : DEFAULT_LOOK}
            enabledThemes={enabledThemes}
            streamMonitorIds={streamMonitorIds}
            monitors={monitors}
          />
        ) : null}

        {slug === "site" ? (
          <AttachmentSettings
            allowed={resolveAllowedAttachmentTypes(current["attachments.allowed_types"])}
            custom={resolveCustomAttachmentExtensions(current["attachments.custom_extensions"])}
          />
        ) : null}

        {slug === "helpdesk" ? <HelpdeskEmailPanel initial={inboundStatus} /> : null}
        {slug === "assistant" ? <AssistantPanel /> : null}

        {scoped.length === 0 && slug === "site" ? null : scoped.length === 0 ? (
          <p className="mt-6 rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:text-slate-400 dark:border-slate-700">
            No settings registered in this category yet.
          </p>
        ) : (
          <SettingsForm
            known={scoped.map((s) => ({
              key: s.key,
              type: s.type,
              label: s.label,
              description: s.description,
              defaultValue: s.defaultValue,
              category: s.category,
            }))}
            current={current}
            category={slug}
          />
        )}
      </main>
    </>
  );
}
