import type { NavItem } from "@/components/settings-nav";

/** The module's two settings pages, side by side. Plain data, so a server page can hand it to the client nav. */
export const SIGNAGE_SETTINGS_NAV: NavItem[] = [
  { href: "/signage/settings", label: "General" },
  { href: "/signage/security", label: "Security settings" },
];
