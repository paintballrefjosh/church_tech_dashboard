import type { NavItem } from "@/components/settings-nav";

/** The Help Desk's admin pages, side by side. Plain data, so a server page can hand it to the client nav. */
export const TICKETS_SETTINGS_NAV: NavItem[] = [
  { href: "/tickets/settings", label: "Settings" },
  { href: "/tickets/categories", label: "Categories" },
];
