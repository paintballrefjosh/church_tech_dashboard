import type { ComponentType, ReactNode } from "react";

type IconType = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/**
 * Page title with a leading lucide icon, used at the top of every primary
 * page. Children are the title text or richer markup (e.g. a subtitle row).
 */
export function PageTitle({ icon: Icon, children }: { icon: IconType; children: ReactNode }) {
  return (
    <h1 className="flex items-center gap-2.5 text-2xl font-semibold">
      <Icon aria-hidden className="h-6 w-6 text-brand-600" />
      <span>{children}</span>
    </h1>
  );
}
