import type { NeedItem } from "./home";

const SEVERITY_ORDER: Record<NeedItem["severity"], number> = { urgent: 0, soon: 1, normal: 2 };
const GROUP_ORDER: Record<NeedItem["group"], number> = { before_service: 0, this_week: 1, later: 2 };

function dueMs(item: NeedItem): number {
  if (!item.dueAt) return Number.POSITIVE_INFINITY;
  const t = Date.parse(item.dueAt);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Orders the "needs you" list: severity first (urgent, soon, normal), then group (before the
 * service, this week, later), then the earliest due time, items without one last. Equal items keep
 * the order they came in. Returns a new array.
 */
export function rankNeeds(items: readonly NeedItem[]): NeedItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const sev = SEVERITY_ORDER[a.item.severity] - SEVERITY_ORDER[b.item.severity];
      if (sev !== 0) return sev;
      const grp = GROUP_ORDER[a.item.group] - GROUP_ORDER[b.item.group];
      if (grp !== 0) return grp;
      const da = dueMs(a.item);
      const db = dueMs(b.item);
      if (da !== db) return da < db ? -1 : 1;
      return a.index - b.index;
    })
    .map((x) => x.item);
}
