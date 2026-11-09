import type { NavItem } from "@/components/settings-nav";

/** The checklist admin pages, side by side under /checklists/manage. Plain data, so a server page can hand it to the client nav. */
export const CHECKLISTS_MANAGE_NAV: NavItem[] = [
  { href: "/checklists/manage", label: "Overview" },
  { href: "/checklists/manage/stations", label: "Stations" },
  { href: "/checklists/manage/services", label: "Services" },
  { href: "/checklists/manage/reports", label: "Reports" },
];
