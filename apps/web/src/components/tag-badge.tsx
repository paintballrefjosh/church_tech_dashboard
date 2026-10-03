import { X } from "lucide-react";
import type { TagColor } from "@church/shared";

const COLOR_CLASS: Record<TagColor, string> = {
  slate: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  rose: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  sky: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
  violet: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
  fuchsia: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200",
};

export interface TagLike {
  id: string;
  name: string;
  color: string;
}

/**
 * Coloured pill rendering a single tag. Pass `onRemove` to add an X button
 * (used by the picker); leave it off for read-only display on cards/lists.
 */
export function TagBadge({
  tag,
  onRemove,
  size = "sm",
}: {
  tag: TagLike;
  onRemove?: () => void;
  size?: "xs" | "sm";
}) {
  const c = (COLOR_CLASS[tag.color as TagColor] ?? COLOR_CLASS.slate);
  const sz =
    size === "xs"
      ? "px-1.5 py-0 text-[10px]"
      : "px-2 py-0.5 text-xs";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-medium ${sz} ${c}`}>
      {tag.name}
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${tag.name}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-0.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10"
        >
          <X className="h-2.5 w-2.5" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
