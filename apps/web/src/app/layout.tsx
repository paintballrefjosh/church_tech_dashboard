import type { Metadata, Viewport } from "next";
import type { CSSProperties, ReactNode } from "react";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Footer } from "@/components/footer";
import { ServiceWorkerRegistrar } from "@/components/sw-registrar";
import { auth, type PageWidth } from "@/lib/auth";
import { apiJson } from "@/lib/api";

interface SiteIdentity {
  name: string;
  tagline: string;
}

/**
 * Generated at request time so the browser tab title tracks the admin's
 * site.name setting. Falls back to "Church Dashboard" if the API is
 * unreachable so we still render something sensible during a cold start.
 */
export async function generateMetadata(): Promise<Metadata> {
  const identity =
    (await apiJson<SiteIdentity>("/api/v1/site/identity").catch(() => null)) ?? {
      name: "Church Dashboard",
      tagline: "",
    };
  return {
    title: identity.name,
    description: identity.tagline || "A modular dashboard for our church.",
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
      apple: [{ url: "/icon.svg" }],
    },
    // iOS PWA-on-homescreen polish. The manifest covers Android + desktop;
    // these meta tags are still required for Safari to treat the site as a
    // standalone app and avoid the white Safari chrome.
    appleWebApp: {
      capable: true,
      title: identity.name,
      statusBarStyle: "default",
    },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  // Read page width from the DB (source of truth) rather than the JWT session:
  // the JWT snapshots the value at login and a client-side session refresh is
  // unreliable, so the preference would revert on reload. One cheap /me read
  // per render keeps it always current; fall back to the session then standard.
  let width: PageWidth | undefined;
  let widthPx: number | null = null;
  if (session?.user) {
    try {
      const me = await apiJson<{ pageWidth?: PageWidth; pageWidthPx?: number | null }>("/api/v1/me");
      width = me.pageWidth;
      widthPx = typeof me.pageWidthPx === "number" ? me.pageWidthPx : null;
    } catch {
      const u = session.user as { pageWidth?: PageWidth; pageWidthPx?: number | null };
      width = u.pageWidth;
      widthPx = typeof u.pageWidthPx === "number" ? u.pageWidthPx : null;
    }
  }
  const pageWidth: PageWidth =
    width && ["fluid", "narrow", "wide", "custom"].includes(width) ? width : "standard";
  // Inline the px cap as a CSS variable when the user is on "custom" so the
  // override rule in globals.css can read it without a per-value selector.
  const style =
    pageWidth === "custom" && typeof widthPx === "number"
      ? ({ ["--page-max-width" as string]: `${widthPx}px` } as CSSProperties)
      : undefined;
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-page-width={pageWidth}
      style={style}
    >
      {/* Body is a flex column so the global Footer sticks to the bottom of
          the viewport when the page content is short. The wrapping div uses
          `flex-1` so it (as a flex *item* of body) grows to fill the space,
          but it must NOT itself be a flex container — otherwise each route's
          <main mx-auto max-w-*> becomes a flex item whose width shrinks to
          its content size (auto margins resolve to 0). Plain block ✔. */}
      <body className="flex min-h-screen flex-col">
        <ThemeProvider>
          <div className="flex-1">{children}</div>
          <Footer />
          <ServiceWorkerRegistrar />
        </ThemeProvider>
      </body>
    </html>
  );
}
