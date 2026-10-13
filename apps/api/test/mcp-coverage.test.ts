import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { pathParamNames } from "../src/mcp/bridge/bridge.types";
import { BRIDGE_TOOLS } from "../src/mcp/bridge/catalogue";
import { listRoutes, type RouteInfo } from "../src/mcp/bridge/routes";
import { COMPLETED_PHASES, ROUTE_RULES, ruleFor } from "../src/mcp/bridge/route-rules";
import { toInputSchema } from "../src/mcp/bridge/bridge-schema";

// Every controller in the app, found by file name so a new one is picked up on its own.
const modules = import.meta.glob("../src/**/*.controller.ts", { eager: true }) as Record<string, Record<string, unknown>>;
const controllers = Object.values(modules)
  .flatMap((m) => Object.values(m))
  .filter((v): v is new (...args: never[]) => unknown => typeof v === "function");
const ROUTES = listRoutes(controllers);
const BY_KEY = new Map(ROUTES.map((r) => [r.key, r]));
const TOOL_KEYS = new Set(BRIDGE_TOOLS.map((t) => `${t.method} ${t.path}`));

// The seven hand-written wiki tools cover these routes (see mcp.tools.ts).
const WIKI_NATIVE = new Set([
  "GET /wiki",
  "GET /wiki/:id",
  "GET /wiki/tree",
  "GET /wiki/:id/revisions",
  "POST /wiki",
  "PATCH /wiki/:id",
  "POST /wiki/folders",
]);
const covered = (r: RouteInfo) => TOOL_KEYS.has(r.key) || WIKI_NATIVE.has(r.key);

describe("MCP coverage of the REST API", () => {
  it("finds the routes", () => {
    expect(ROUTES.length).toBeGreaterThan(250);
  });

  it("covers every route: a tool, or a rule that says why not (add one when you add an endpoint)", () => {
    const uncovered = ROUTES.filter((r) => !covered(r) && !ruleFor(r)).map((r) => r.key);
    expect(uncovered).toEqual([]);
  });

  it("has no rule that no longer applies to anything (delete a rule once every route under it has a tool)", () => {
    const used = new Set(ROUTES.filter((r) => !covered(r)).map((r) => ruleFor(r)));
    const stale = ROUTE_RULES.filter((rule) => !used.has(rule)).map((rule) => rule.pattern);
    expect(stale).toEqual([]);
  });

  it("has every rule give its reason, and every pending rule a phase", () => {
    for (const rule of ROUTE_RULES) {
      expect(rule.reason, rule.pattern).toBeTruthy();
      if (rule.status === "pending") expect([1, 2, 3, 4], rule.pattern).toContain(rule.phase);
      else expect(rule.phase, rule.pattern).toBeUndefined();
    }
  });

  it("has nothing pending from a finished phase", () => {
    const left = ROUTE_RULES.filter((r) => r.status === "pending" && COMPLETED_PHASES.includes(r.phase!)).map(
      (r) => r.pattern,
    );
    expect(left).toEqual([]);
  });

  it("offers no tool for a public, session-only or unknown route", () => {
    for (const t of BRIDGE_TOOLS) {
      const route = BY_KEY.get(`${t.method} ${t.path}`);
      expect(route, `${t.name}: no such route ${t.method} ${t.path}`).toBeTruthy();
      expect(route!.isPublic, `${t.name} is public`).toBe(false);
      expect(route!.sessionOnly, `${t.name} is session-only`).toBe(false);
    }
  });
});

describe("MCP tool catalogue", () => {
  it("keeps each tool's permissions equal to its route's @RequirePermissions", () => {
    for (const t of BRIDGE_TOOLS) {
      const route = BY_KEY.get(`${t.method} ${t.path}`)!;
      expect([...t.permissions].sort(), `${t.name} permissions`).toEqual([...route.permissions].sort());
    }
  });

  it("classes a tool by its method: reads are GET, anything else is not a read", () => {
    for (const t of BRIDGE_TOOLS) {
      expect(t.cls === "read", `${t.name}`).toBe(t.method === "GET");
    }
  });

  it("has unique snake_case names within the 64 character limit and a real description", () => {
    const names = BRIDGE_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of BRIDGE_TOOLS) {
      expect(t.name, t.name).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
      expect(t.description.length, `${t.name} description`).toBeGreaterThan(30);
      expect(t.name).not.toMatch(/^wiki_(search|get_page|tree|list_revisions|create_page|update_page|create_folder)$/);
    }
  });

  it("takes every path parameter as an argument", () => {
    for (const t of BRIDGE_TOOLS) {
      for (const p of pathParamNames(t.path)) {
        expect(Object.keys(t.input.shape), `${t.name} needs ${p}`).toContain(p);
      }
    }
  });

  it("builds a JSON Schema for every tool", () => {
    for (const t of BRIDGE_TOOLS) {
      const schema = toInputSchema(t) as Record<string, unknown>;
      expect(schema.type, t.name).toBe("object");
      expect(JSON.stringify(schema), t.name).not.toContain("$ref");
    }
  });

  it("marks a delete tool destructive on purpose", () => {
    for (const t of BRIDGE_TOOLS.filter((x) => x.method === "DELETE")) {
      expect(t.destructive, `${t.name} must say destructive: true`).toBe(true);
    }
  });
});
