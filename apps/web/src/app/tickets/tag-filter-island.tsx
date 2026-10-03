"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { TagFilter } from "@/components/tag-filter";

/**
 * Thin client wrapper that bridges the server-rendered ticket list to the
 * <TagFilter> component. Pushing a new tag selection writes the `tag=` query
 * param so the server can re-render with the filter applied. Used identically
 * on /notes and /wiki below.
 */
export function TicketsTagFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selected = searchParams.get("tag");

  return (
    <TagFilter
      selectedId={selected}
      onChange={(id) => {
        const sp = new URLSearchParams(searchParams.toString());
        if (id) sp.set("tag", id);
        else sp.delete("tag");
        router.replace(`${pathname}?${sp.toString()}`);
      }}
    />
  );
}
