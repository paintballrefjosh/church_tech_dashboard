import {
  Activity,
  BookOpen,
  Boxes,
  CalendarDays,
  CheckCheck,
  CircleCheck,
  Cloud,
  Cog,
  Copy,
  FilePen,
  Globe,
  HandMetal,
  History,
  Hourglass,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  LogOut,
  Moon,
  Network,
  Pause,
  Play,
  Plus,
  Presentation,
  Printer,
  ScrollText,
  Server,
  Shield,
  ShieldCheck,
  StickyNote,
  Sun,
  Tags,
  Bell,
  User,
  UsersRound,
  Archive,
  Zap,
  type LucideIcon,
  CalendarClock,
} from "lucide-react";

/**
 * What the Cmd/Ctrl-K palette offers, decided here and nowhere else: pure functions of who the person is and which page
 * they are on, unit-tested in palette.test.ts. The component only draws the list and carries out an action.
 *
 * Rules: a command that goes somewhere (`go`) is offered when the person has the module; a command that does something
 * (`run`) reuses an existing audited API route and is offered when the person holds the permission the route asks for (the
 * route still decides: a refusal is shown, never swallowed). Anything that changes what other people see (pausing alerts)
 * asks for confirmation first, and says what it will do.
 */

export type Access = Record<string, "user" | "moderator" | "admin">;

export interface PaletteUser {
  id: string;
  /** Flat permission strings from `GET /me`. */
  permissions: string[];
  access: Access;
}

export type PaletteGroup = "This page" | "Actions" | "Create" | "Go to";

/** What a `run` command does; the component maps each to a request. */
export type ActionId =
  | "theme"
  | "copy-link"
  | "sign-out"
  | "notifications-read-all"
  | "alerts-pause"
  | "alerts-resume"
  | "ticket-take"
  | "ticket-resolve"
  | "ticket-waiting"
  | "wiki-confirm";

interface Base {
  id: string;
  group: PaletteGroup;
  label: string;
  /** Extra words that find it ("restart" for sign out). */
  keywords: string;
  icon: LucideIcon;
}
export interface GoCommand extends Base {
  kind: "go";
  href: string;
}
export interface RunCommand extends Base {
  kind: "run";
  action: ActionId;
  /** The page or thing it acts on (a ticket id, a wiki page id, a number of minutes). */
  arg?: string | number;
  /** When set the person must confirm, and is told this first. */
  confirm?: string;
}
export type PaletteCommand = GoCommand | RunCommand;

export interface PaletteState {
  user: PaletteUser | null;
  pathname: string;
  /** Alerts are paused right now; null = not known (yet, or not asked because the person cannot change it). */
  alertsPaused: boolean | null;
  dark: boolean;
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/** The ticket or wiki page the person is looking at, from the address. */
export function currentThing(pathname: string): { kind: "ticket" | "wiki"; id: string } | null {
  const t = new RegExp(`^/tickets/(${UUID})/?$`).exec(pathname);
  if (t) return { kind: "ticket", id: t[1]!.toLowerCase() };
  const w = new RegExp(`^/wiki/(${UUID})(?:/|$)`).exec(pathname);
  if (w) return { kind: "wiki", id: w[1]!.toLowerCase() };
  return null;
}

const go = (id: string, group: PaletteGroup, label: string, href: string, icon: LucideIcon, keywords = ""): GoCommand => ({
  kind: "go",
  id,
  group,
  label,
  href,
  icon,
  keywords,
});

/** Pages. `module` = needs any tier of that module; `admin` = needs the site admin tier. */
const DESTINATIONS: Array<{ module?: string; admin?: boolean; cmd: GoCommand }> = [
  { cmd: go("go:home", "Go to", "Dashboard", "/", LayoutDashboard, "home start") },
  { module: "tickets", cmd: go("go:tickets", "Go to", "Help desk", "/tickets", LifeBuoy, "tickets requests") },
  { module: "wiki", cmd: go("go:wiki", "Go to", "Wiki", "/wiki", BookOpen, "docs pages") },
  { module: "wiki", cmd: go("go:wiki-review", "Go to", "Wiki pages to review", "/wiki/review", ListChecks, "out of date stale") },
  { module: "wiki", cmd: go("go:wiki-templates", "Go to", "Wiki templates", "/wiki/templates", BookOpen, "outline") },
  { module: "notes", cmd: go("go:notes", "Go to", "Notes", "/notes", StickyNote) },
  { module: "monitoring", cmd: go("go:monitoring", "Go to", "Monitoring", "/monitoring", Activity, "services uptime incidents") },
  { module: "monitoring", cmd: go("go:infra", "Go to", "Infrastructure", "/monitoring/infra", Server, "hosts servers docker proxmox") },
  { module: "monitoring", cmd: go("go:unifi", "Go to", "Network (UniFi)", "/monitoring/network", Network, "wifi access points") },
  { module: "monitoring", cmd: go("go:cisco", "Go to", "Network (Cisco)", "/monitoring/network-cisco", Network, "switches ports vlan") },
  { module: "monitoring", cmd: go("go:ups", "Go to", "UPS", "/monitoring/ups", Zap, "battery power") },
  { module: "monitoring", cmd: go("go:ipam", "Go to", "IPAM", "/ipam", Boxes, "ip addresses subnets") },
  { module: "monitoring", cmd: go("go:dns", "Go to", "DNS", "/dns", Globe, "records zones") },
  { module: "monitoring", cmd: go("go:cabinets", "Go to", "Cabinets", "/cabinets", Server, "racks elevation rack u server room") },
  { module: "monitoring", cmd: go("go:renewals", "Go to", "Renewals", "/renewals", CalendarClock, "licence license domain warranty subscription ccli expiry") },
  { module: "monitoring", cmd: go("go:alert-channels", "Go to", "Alert channels", "/monitoring/alert-channels", Activity, "slack teams discord ntfy pushover sms webhook") },
  { module: "printers", cmd: go("go:printers", "Go to", "Printers", "/printers", Printer, "toner") },
  { module: "propresenter", cmd: go("go:propresenter", "Go to", "ProPresenter", "/propresenter", Presentation, "slides") },
  { module: "planning_center", cmd: go("go:planning-center", "Go to", "Planning Center Services", "/planning-center", CalendarDays, "schedule") },
  { module: "checklists", cmd: go("go:checklists", "Go to", "Checklists", "/checklists", ListChecks, "tasks sunday") },
  { cmd: go("go:status", "Go to", "Service status", "/status", Activity, "is it up") },
  { cmd: go("go:notifications", "Go to", "Notifications", "/notifications", Bell, "inbox bell") },
  { cmd: go("go:profile", "Go to", "My profile and notification settings", "/me", User, "account quiet hours push password") },
  { cmd: go("go:my-sessions", "Go to", "My signed-in browsers", "/me/security", ShieldCheck, "sessions devices sign out") },
  { cmd: go("go:my-tokens", "Go to", "My API tokens", "/me/api-tokens", KeyRound, "bearer") },
  { admin: true, cmd: go("go:admin", "Go to", "Admin home", "/admin", Shield) },
  { admin: true, cmd: go("go:users", "Go to", "Users", "/admin/users", UsersRound, "accounts people approve") },
  { admin: true, cmd: go("go:groups", "Go to", "Groups", "/admin/groups", UsersRound, "access") },
  { admin: true, cmd: go("go:tags", "Go to", "Tags", "/admin/tags", Tags) },
  { admin: true, cmd: go("go:settings", "Go to", "Site settings", "/admin/settings/site", Cog, "configuration smtp") },
  { admin: true, cmd: go("go:security", "Go to", "Security overview", "/admin/security", ShieldCheck, "two-factor posture") },
  { admin: true, cmd: go("go:backups", "Go to", "Backups", "/admin/backups", Archive, "restore") },
  { admin: true, cmd: go("go:cluster", "Go to", "Cluster", "/admin/cluster", Cloud, "nodes") },
  { admin: true, cmd: go("go:audit", "Go to", "Audit log", "/admin/audit", ScrollText, "history who changed") },
  { admin: true, cmd: go("go:permissions", "Go to", "Permission matrix", "/admin/permissions", KeyRound) },
  { admin: true, cmd: go("go:admin-tokens", "Go to", "API tokens (everyone's)", "/admin/api-tokens", KeyRound) },
];

const CREATE: Array<{ module: string; cmd: GoCommand }> = [
  { module: "tickets", cmd: go("create:ticket", "Create", "New ticket", "/tickets/new", Plus, "request problem") },
  { module: "wiki", cmd: go("create:wiki", "Create", "New wiki page", "/wiki/new", Plus, "document") },
  { module: "notes", cmd: go("create:note", "Create", "New note", "/notes", Plus, "write") },
];

const PAUSE_CHOICES: Array<{ minutes: number; label: string }> = [
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 480, label: "8 hours" },
  { minutes: 1440, label: "24 hours" },
];

const run = (id: string, group: PaletteGroup, label: string, action: ActionId, icon: LucideIcon, keywords = "", extra: Partial<RunCommand> = {}): RunCommand => ({
  kind: "run",
  id,
  group,
  label,
  action,
  icon,
  keywords,
  ...extra,
});

/**
 * Every command this person can use here, in the order the palette shows them: what they can do with the page they are
 * on, then actions, then create, then places to go.
 */
export function paletteCommands(state: PaletteState): PaletteCommand[] {
  const { user, pathname } = state;
  if (!user) return [];
  const has = (p: string) => user.permissions.includes(p);
  const out: PaletteCommand[] = [];

  // ---- this page ----
  const thing = currentThing(pathname);
  if (thing?.kind === "ticket" && has("tickets:read:any")) {
    out.push(
      run("page:ticket-take", "This page", "Take this ticket", "ticket-take", HandMetal, "assign me", { arg: thing.id }),
      run("page:ticket-waiting", "This page", "Waiting on the requester", "ticket-waiting", Hourglass, "status pending", { arg: thing.id }),
      run("page:ticket-resolve", "This page", "Mark this ticket resolved", "ticket-resolve", CircleCheck, "close done fixed", { arg: thing.id }),
    );
  }
  if (thing?.kind === "wiki") {
    if (!/\/edit\/?$/.test(pathname)) out.push(go("page:wiki-edit", "This page", "Edit this page", `/wiki/${thing.id}/edit`, FilePen, "change"));
    if (!/\/revisions\/?$/.test(pathname)) out.push(go("page:wiki-history", "This page", "History of this page", `/wiki/${thing.id}/revisions`, History, "revisions diff versions"));
    if (has("wiki:write:own") || has("wiki:write:any")) {
      out.push(run("page:wiki-confirm", "This page", "This page is still correct", "wiki-confirm", CircleCheck, "review confirm up to date", { arg: thing.id }));
    }
  }

  // ---- actions ----
  out.push(
    run("act:theme", "Actions", state.dark ? "Switch to light mode" : "Switch to dark mode", "theme", state.dark ? Sun : Moon, "theme appearance"),
    run("act:copy-link", "Actions", "Copy link to this page", "copy-link", Copy, "url share"),
    run("act:read-all", "Actions", "Mark all notifications as read", "notifications-read-all", CheckCheck, "bell inbox clear"),
  );
  if (has("monitors:write:any") && state.alertsPaused !== null) {
    if (state.alertsPaused) {
      out.push(run("act:alerts-resume", "Actions", "Resume alerts", "alerts-resume", Play, "maintenance mode unpause on"));
    } else {
      for (const c of PAUSE_CHOICES) {
        out.push(
          run(`act:alerts-pause-${c.minutes}`, "Actions", `Pause alerts for ${c.label}`, "alerts-pause", Pause, "maintenance mode silence quiet", {
            arg: c.minutes,
            confirm: `Alerts for services, hosts, switches and the rest of Monitoring will not be sent to anyone for ${c.label}. Incidents are still recorded, and alerts come back by themselves.`,
          }),
        );
      }
    }
  }
  out.push(run("act:sign-out", "Actions", "Sign out", "sign-out", LogOut, "log out leave"));

  // ---- create ----
  for (const c of CREATE) if (c.module in user.access) out.push(c.cmd);

  // ---- go to ----
  const isAdmin = user.access.admin === "admin";
  for (const d of DESTINATIONS) {
    if (d.admin && !isAdmin) continue;
    if (d.module && !(d.module in user.access)) continue;
    out.push(d.cmd);
  }
  return out;
}

/** Group order for drawing. */
export const GROUP_ORDER: PaletteGroup[] = ["This page", "Actions", "Create", "Go to"];
