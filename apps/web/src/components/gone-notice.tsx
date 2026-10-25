import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/**
 * Shown in place of a detail page whose subject no longer exists (it was deleted after a link to it was made, for
 * example in a notification), instead of a bare 404.
 */
export function GoneNotice({ what, backHref, backLabel }: { what: string; backHref: string; backLabel: string }) {
  return (
    <div className="space-y-3">
      <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {backLabel}
      </Link>
      <div className="rounded-md border border-slate-300 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-base font-semibold">This {what} no longer exists</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          It was deleted after this link was made. Anything recorded about it went with it.
        </p>
      </div>
    </div>
  );
}
