import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  answerSaysNotFound,
  assistantActionsFor,
  assistantBudgetLevel,
  assistantProviderDown,
  parseProposal,
  proposalHeadline,
  proposalRequest,
  proposalResultUrl,
  proposalToolSchema,
  proposalTransitionProblem,
  ASSISTANT_ACTION_KINDS,
} from "@church/shared";
import { summariseAnswers } from "../src/assistant/assistant.service";

/** Proposed actions and the usage figures (docs/assistant.md phases 2-3): the pure rules. */
const all = ASSISTANT_ACTION_KINDS;

describe("assistant proposals", () => {
  it("offers a kind only to a person who holds the route's permission", () => {
    expect(assistantActionsFor([])).toEqual([]);
    expect(assistantActionsFor([PERMISSIONS.TICKETS_WRITE_OWN])).toEqual(["create_ticket"]);
    expect(assistantActionsFor([PERMISSIONS.MONITORS_WRITE_ANY, PERMISSIONS.WIKI_CREATE])).toEqual(["acknowledge_incident", "wiki_draft", "pause_alerts"]);
  });

  it("keeps only the chosen kind's fields and checks them strictly", () => {
    const r = parseProposal({ kind: "create_ticket", title: "Projector dead", description: "Room 2", incidentId: "x", hours: 99 }, all);
    expect(r).toEqual({ ok: true, payload: { kind: "create_ticket", title: "Projector dead", description: "Room 2", priority: "normal" } });
    expect(parseProposal({ kind: "pause_alerts", hours: 25 }, all).ok).toBe(false);
    expect(parseProposal({ kind: "pause_alerts", hours: 0 }, all).ok).toBe(false);
    expect(parseProposal({ kind: "pause_alerts", hours: 1.5 }, all).ok).toBe(false);
    expect(parseProposal({ kind: "acknowledge_incident", incidentId: "not-a-uuid" }, all).ok).toBe(false);
    expect(parseProposal({ kind: "create_ticket", title: "two\nlines" }, all).ok).toBe(false);
    expect(parseProposal({ kind: "create_ticket", title: "  " }, all).ok).toBe(false);
    expect(parseProposal({ kind: "delete_everything" }, all)).toMatchObject({ ok: false });
    expect(parseProposal(null, all).ok).toBe(false);
  });

  it("refuses a kind the person may not do, even when the model sends it", () => {
    expect(parseProposal({ kind: "pause_alerts", hours: 2 }, ["create_ticket"])).toEqual({ ok: false, error: "pause_alerts is not something this person may do" });
  });

  it("the tool schema names only the kinds offered", () => {
    const s = proposalToolSchema(["create_ticket"]) as { properties: { kind: { enum: string[] } }; additionalProperties: boolean };
    expect(s.properties.kind.enum).toEqual(["create_ticket"]);
    expect(s.additionalProperties).toBe(false);
  });

  it("builds the normal route call for each kind", () => {
    expect(proposalRequest({ kind: "create_ticket", title: "t", description: "d", priority: "high" })).toEqual({ method: "POST", path: "/tickets", body: { title: "t", description: "d", priority: "high" } });
    const id = "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    expect(proposalRequest({ kind: "acknowledge_incident", incidentId: id })).toEqual({ method: "POST", path: `/monitors/incidents/${id}/ack`, body: null });
    // A draft is readable by its author only: group visibility with no groups.
    expect(proposalRequest({ kind: "wiki_draft", title: "t", body: "b" }).body).toEqual({ title: "t", body: "b", visibility: "group", acl: [] });
    // Pausing always carries an end.
    expect(proposalRequest({ kind: "pause_alerts", hours: 4 }).body).toEqual({ enabled: true, minutes: 240 });
  });

  it("says plainly that pausing affects everyone, and where the result lives", () => {
    expect(proposalHeadline({ kind: "pause_alerts", hours: 1 })).toMatch(/EVERYONE for 1 hour \(/);
    expect(proposalResultUrl({ kind: "create_ticket", title: "t", description: "", priority: "normal" }, { id: "abc" })).toBe("/tickets/abc");
    expect(proposalResultUrl({ kind: "wiki_draft", title: "t", body: "" }, { id: "p1" })).toBe("/wiki/p1");
    expect(proposalResultUrl({ kind: "wiki_draft", title: "t", body: "" }, null)).toBeNull();
    expect(proposalResultUrl({ kind: "pause_alerts", hours: 1 }, {})).toBe("/monitoring");
  });

  it("a decision is made once", () => {
    expect(proposalTransitionProblem("proposed", "done")).toBeNull();
    expect(proposalTransitionProblem("proposed", "dismissed")).toBeNull();
    expect(proposalTransitionProblem("done", "dismissed")).toMatch(/already done/);
    expect(proposalTransitionProblem("dismissed", "done")).toMatch(/already dismissed/);
    expect(proposalTransitionProblem("proposed", "proposed")).not.toBeNull();
  });
});

describe("assistant figures", () => {
  it("recognises an answer that could not find something", () => {
    expect(answerSaysNotFound("I couldn't find a VLAN called guests.")).toBe(true);
    expect(answerSaysNotFound("I could not locate that printer.")).toBe(true);
    expect(answerSaysNotFound("No matching records found.")).toBe(true);
    expect(answerSaysNotFound("There are 3 VLANs.")).toBe(false);
    expect(answerSaysNotFound("The founder found it.")).toBe(false);
  });

  it("budget notices at 80% and 100%, none without a budget", () => {
    expect(assistantBudgetLevel(5, 0)).toBe(0);
    expect(assistantBudgetLevel(7.99, 10)).toBe(0);
    expect(assistantBudgetLevel(8, 10)).toBe(80);
    expect(assistantBudgetLevel(10, 10)).toBe(100);
  });

  it("the provider is down after three provider failures in a row, up after one answer", () => {
    const err = (errorKind: string | null) => ({ outcome: "error", errorKind });
    expect(assistantProviderDown([])).toBeNull();
    expect(assistantProviderDown([{ outcome: "ok", errorKind: null }, err("timeout"), err("timeout")])).toBe(false);
    expect(assistantProviderDown([err("timeout"), err("unreachable"), err("unauthorised")])).toBe(true);
    expect(assistantProviderDown([err("timeout"), err("timeout")])).toBeNull();
    // A person's limit or a refused question says nothing about the provider.
    expect(assistantProviderDown([err("limited"), err("timeout"), err("timeout")])).toBeNull();
  });

  it("summarises a month of answers", () => {
    const row = (o: Partial<Parameters<typeof summariseAnswers>[0][number]>) => ({ outcome: "ok", errorKind: null, latencyMs: 1000, firstTokenMs: 200, lookups: [], proposals: [], notFound: false, rating: null, ...o });
    const s = summariseAnswers([
      row({ latencyMs: 1000, lookups: ["search", "tickets_list"], rating: 1 }),
      row({ latencyMs: 3000, lookups: ["search"], proposals: ["create_ticket"], rating: -1 }),
      row({ outcome: "error", errorKind: "timeout", latencyMs: 30000, firstTokenMs: null }),
      row({ latencyMs: 2000, notFound: true }),
    ]);
    expect(s.total).toBe(4);
    expect(s.outcomes).toEqual([{ name: "ok", n: 3 }, { name: "error", n: 1 }]);
    expect(s.errors).toEqual([{ name: "timeout", n: 1 }]);
    expect(s.latencyMs).toEqual({ p50: 3000, p95: 30000 });
    expect(s.firstTokenMs.p50).toBe(200);
    expect(s.ratings).toEqual({ up: 1, down: 1 });
    expect(s.notFound).toBe(1);
    expect(s.lookups[0]).toEqual({ name: "search", n: 2 });
    expect(s.proposals).toEqual([{ name: "create_ticket", n: 1 }]);
    expect(summariseAnswers([]).latencyMs).toEqual({ p50: null, p95: null });
  });
});
