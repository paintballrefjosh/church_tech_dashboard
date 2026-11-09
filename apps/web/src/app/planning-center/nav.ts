import type { NavItem } from "@/components/settings-nav";

/** Planning Center's two admin pages, side by side. Plain data, so a server page can hand it to the client nav. */
export const PLANNING_CENTER_SETTINGS_NAV: NavItem[] = [
  { href: "/planning-center/settings", label: "Connection" },
  { href: "/planning-center/links", label: "People links" },
];
