import { apiFetch } from "@/lib/api";
import { APP_VERSION } from "@/lib/version";

interface PublicChrome {
  siteName: string;
  siteTagline: string;
  footerMessage: string;
}

/**
 * Global app footer. Version on the left, an admin-configurable site message
 * on the right (`site.footer_message` in the settings table — leave blank to
 * hide the right side entirely).
 *
 * Server component: the public-chrome endpoint is `@Public()` on the api so
 * this renders correctly on the sign-in page too. Any failure falls back to
 * "no message" — the version bar always renders.
 */
export async function Footer() {
  let chrome: PublicChrome = { siteName: "", siteTagline: "", footerMessage: "" };
  try {
    const res = await apiFetch("/api/v1/settings/public");
    if (res.ok) chrome = (await res.json()) as PublicChrome;
  } catch {
    // network failure during SSR — render the footer with the static bits only
  }

  return (
    <footer className="border-t border-slate-300 bg-white/60 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-400">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <span className="font-mono">{APP_VERSION}</span>
        {chrome.footerMessage ? (
          <span className="truncate text-right">{chrome.footerMessage}</span>
        ) : (
          <span aria-hidden />
        )}
      </div>
    </footer>
  );
}
