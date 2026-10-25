import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/** The way back from the shared device models pages to the page they were opened from. */
export function ModelsBackLink({ href, label }: { href: string; label: string }) {
  return (
    <div className="mb-4 flex items-center gap-3 text-sm">
      <Link href={href} className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {label}
      </Link>
      <span className="text-slate-500 dark:text-slate-400">Device models</span>
    </div>
  );
}
