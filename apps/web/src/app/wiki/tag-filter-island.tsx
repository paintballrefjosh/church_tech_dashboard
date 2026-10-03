"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { TagFilter } from "@/components/tag-filter";

export function WikiTagFilter() {
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
