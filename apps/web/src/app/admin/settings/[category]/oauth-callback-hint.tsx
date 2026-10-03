"use client";

import { useState } from "react";
import { ExternalLink, Copy, Check } from "lucide-react";

/**
 * Renders the OAuth redirect URL the user needs to paste into the provider
 * console. Derived server-side from the current host so it always matches
 * the one the user will hit in the browser (dynamic-origin design). The
 * Copy button gives one-click selection without the click-and-drag dance.
 */
export function OAuthCallbackHint({
  provider,
  callbackUrl,
  consoleUrl,
}: {
  provider: string;
  callbackUrl: string;
  consoleUrl: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no-op */
    }
  }

  return (
    <div className="mt-4 rounded-md border border-brand-500/40 bg-brand-50 p-3 dark:border-brand-500/30 dark:bg-brand-500/10">
      <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
        OAuth redirect URI for {provider}
      </p>
      <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
        Paste this into the &quot;Authorized redirect URIs&quot; field on the {provider} side.{" "}
        <a
          href={consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium text-brand-600 underline hover:no-underline dark:text-brand-500"
        >
          Open console <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs text-slate-800 dark:bg-slate-900 dark:text-slate-200">
          {callbackUrl}
        </code>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" aria-hidden /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" aria-hidden /> Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}
