import { describe, expect, it } from "vitest";
import { currentThing, paletteCommands, type PaletteState } from "./palette";

const ID = "3f2b8c1e-0a4d-4e57-9b1c-5d6e7f8a9b0c";
const base = (over: Partial<PaletteState> = {}, perms: string[] = [], access: Record<string, "user" | "moderator" | "admin"> = { tickets: "user", wiki: "user", notes: "user" }): PaletteState => ({
  user: { id: "u1", permissions: perms, access },
  pathname: "/",
  alertsPaused: null,
  dark: false,
  ...over,
});
const ids = (s: PaletteState) => paletteCommands(s).map((c) => c.id);

describe("currentThing", () => {
  it("finds a ticket or a wiki page by its address, and nothing else", () => {
    expect(currentThing(`/tickets/${ID}`)).toEqual({ kind: "ticket", id: ID });
    expect(currentThing(`/wiki/${ID}/edit`)).toEqual({ kind: "wiki", id: ID });
    expect(currentThing(`/wiki/${ID}/revisions`)).toEqual({ kind: "wiki", id: ID });
    for (const p of ["/tickets", "/tickets/new", "/wiki/review", "/wiki/templates", "/wiki/new", `/tickets/${ID}/x`, "/"]) {
      expect(currentThing(p), p).toBeNull();
    }
  });
});

describe("paletteCommands", () => {
  it("offers nothing to someone who is not signed in", () => {
    expect(paletteCommands({ ...base(), user: null })).toEqual([]);
  });

  it("only offers pages for modules the person has, and admin pages only to site admins", () => {
    const plain = ids(base());
    expect(plain).toContain("go:tickets");
    expect(plain).toContain("go:wiki");
    expect(plain).not.toContain("go:printers");
    expect(plain).not.toContain("go:monitoring");
    expect(plain.some((i) => i.startsWith("go:") && ["go:users", "go:backups", "go:audit", "go:settings"].includes(i))).toBe(false);
    const admin = ids(base({}, [], { tickets: "admin", monitoring: "admin", admin: "admin" }));
    for (const i of ["go:users", "go:backups", "go:security", "go:cluster", "go:monitoring", "go:dns"]) expect(admin).toContain(i);
    // A module admin who is not a site admin does not get the site admin pages.
    expect(ids(base({}, [], { monitoring: "admin" }))).not.toContain("go:users");
  });

  it("always offers the personal pages and actions", () => {
    const s = ids(base());
    for (const i of ["go:home", "go:notifications", "go:profile", "go:my-sessions", "act:theme", "act:copy-link", "act:read-all", "act:sign-out"]) expect(s).toContain(i);
  });

  it("offers create only for modules the person has", () => {
    expect(ids(base())).toEqual(expect.arrayContaining(["create:ticket", "create:wiki", "create:note"]));
    expect(ids(base({}, [], { notes: "user" }))).toEqual(["act:theme", "act:copy-link", "act:read-all", "act:sign-out", "create:note", "go:home", "go:notes", "go:status", "go:notifications", "go:profile", "go:my-sessions", "go:my-tokens"]);
  });

  it("names the theme it would switch to", () => {
    const label = (dark: boolean) => paletteCommands(base({ dark })).find((c) => c.id === "act:theme")!.label;
    expect(label(false)).toBe("Switch to dark mode");
    expect(label(true)).toBe("Switch to light mode");
  });

  describe("pausing alerts", () => {
    it("is offered only with the permission, and only once the current state is known", () => {
      expect(ids(base({ alertsPaused: false }, ["monitors:write:any"], { monitoring: "moderator" })).some((i) => i.startsWith("act:alerts"))).toBe(true);
      expect(ids(base({ alertsPaused: false }, ["monitors:read:any"], { monitoring: "user" })).some((i) => i.startsWith("act:alerts"))).toBe(false);
      expect(ids(base({ alertsPaused: null }, ["monitors:write:any"], { monitoring: "moderator" })).some((i) => i.startsWith("act:alerts"))).toBe(false);
    });
    it("offers four lengths, each asking for confirmation and saying what happens", () => {
      const pauses = paletteCommands(base({ alertsPaused: false }, ["monitors:write:any"], { monitoring: "moderator" })).filter((c) => c.id.startsWith("act:alerts-pause"));
      expect(pauses.map((c) => (c.kind === "run" ? c.arg : null))).toEqual([60, 240, 480, 1440]);
      for (const c of pauses) {
        expect(c.kind === "run" && c.confirm).toMatch(/will not be sent/);
      }
    });
    it("offers only Resume while paused, with no confirmation", () => {
      const cmds = paletteCommands(base({ alertsPaused: true }, ["monitors:write:any"], { monitoring: "moderator" })).filter((c) => c.id.startsWith("act:alerts"));
      expect(cmds.map((c) => c.id)).toEqual(["act:alerts-resume"]);
      expect(cmds[0]!.kind === "run" && cmds[0]!.confirm).toBeFalsy();
    });
  });

  describe("on a ticket", () => {
    it("offers take, waiting and resolve to staff, with the ticket id", () => {
      const cmds = paletteCommands(base({ pathname: `/tickets/${ID}` }, ["tickets:read:any"]));
      const page = cmds.filter((c) => c.group === "This page");
      expect(page.map((c) => c.id)).toEqual(["page:ticket-take", "page:ticket-waiting", "page:ticket-resolve"]);
      expect(page.every((c) => c.kind === "run" && c.arg === ID)).toBe(true);
      expect(cmds[0]!.group).toBe("This page");
    });
    it("offers nothing on the page to someone who is not staff", () => {
      expect(paletteCommands(base({ pathname: `/tickets/${ID}` }, ["tickets:read:own"])).some((c) => c.group === "This page")).toBe(false);
    });
  });

  describe("on a wiki page", () => {
    it("offers edit, history and confirming to someone who can write", () => {
      const page = paletteCommands(base({ pathname: `/wiki/${ID}` }, ["wiki:write:own"])).filter((c) => c.group === "This page");
      expect(page.map((c) => c.id)).toEqual(["page:wiki-edit", "page:wiki-history", "page:wiki-confirm"]);
      expect(page[0]).toMatchObject({ kind: "go", href: `/wiki/${ID}/edit` });
    });
    it("does not offer to open the screen already open", () => {
      const onEdit = paletteCommands(base({ pathname: `/wiki/${ID}/edit` }, ["wiki:write:own"])).map((c) => c.id);
      expect(onEdit).not.toContain("page:wiki-edit");
      expect(onEdit).toContain("page:wiki-history");
      const onHistory = paletteCommands(base({ pathname: `/wiki/${ID}/revisions` }, ["wiki:write:own"])).map((c) => c.id);
      expect(onHistory).not.toContain("page:wiki-history");
    });
    it("leaves out confirming for someone who cannot write", () => {
      expect(paletteCommands(base({ pathname: `/wiki/${ID}` }, ["wiki:read:own"])).map((c) => c.id)).not.toContain("page:wiki-confirm");
    });
  });
});
