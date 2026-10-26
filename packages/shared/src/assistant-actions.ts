import { z } from "zod";
import { PERMISSIONS } from "./permissions";
import { TICKET_PRIORITIES } from "./schemas/ticket";

/**
 * Proposed actions (docs/assistant.md section 16, phase 3). The model may only PROPOSE: its `propose_action` tool records a
 * proposal and changes nothing. The person sees exactly what will be sent, may edit the text fields, and confirms in the
 * page; the page then makes the normal API call AS THE PERSON (so permissions, audit and read-your-writes are unchanged),
 * built by `proposalRequest` from what is shown. The rules here are pure, unit-tested in apps/api/test/assistant-actions.test.ts.
 */

export const ASSISTANT_ACTION_KINDS = ["create_ticket", "acknowledge_incident", "wiki_draft", "pause_alerts"] as const;
export type AssistantActionKind = (typeof ASSISTANT_ACTION_KINDS)[number];

/** The permission the route behind each kind needs: a kind is offered to the model only when the person holds it. */
export const ASSISTANT_ACTION_PERMISSION: Record<AssistantActionKind, string> = {
  create_ticket: PERMISSIONS.TICKETS_WRITE_OWN,
  acknowledge_incident: PERMISSIONS.MONITORS_WRITE_ANY,
  wiki_draft: PERMISSIONS.WIKI_CREATE,
  pause_alerts: PERMISSIONS.MONITORS_WRITE_ANY,
};

/** At most this many proposals in one answer (a model looping on the tool cannot fill the page). */
export const MAX_PROPOSALS_PER_ANSWER = 3;
/** Pausing alerts from a proposal is always for a stated time: never "until turned back on". */
export const PAUSE_MAX_HOURS = 24;

const line = (max: number) => z.string().trim().min(1).max(max).refine((v) => !/[\r\n]/.test(v), "must be one line");

export const assistantProposalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_ticket"), title: line(200), description: z.string().max(20_000).default(""), priority: z.enum(TICKET_PRIORITIES).default("normal") }).strict(),
  z.object({ kind: z.literal("acknowledge_incident"), incidentId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("wiki_draft"), title: line(200), body: z.string().max(200_000).default("") }).strict(),
  z.object({ kind: z.literal("pause_alerts"), hours: z.number().int().min(1).max(PAUSE_MAX_HOURS) }).strict(),
]);
export type AssistantProposalPayload = z.infer<typeof assistantProposalPayloadSchema>;

export type AssistantProposalStatus = "proposed" | "done" | "dismissed";

export interface AssistantProposal {
  id: string;
  kind: AssistantActionKind;
  status: AssistantProposalStatus;
  payload: AssistantProposalPayload;
  /** What the server read itself (an incident's monitor and reason), never the model's description of it. */
  context: string | null;
  /** The page of what it is about (the monitor or host of an incident), from the same server read. */
  contextUrl: string | null;
  /** The thing the action made or touched, once done (a site path). */
  resultUrl: string | null;
  decidedAt: string | null;
}

/** What the model's tool may send: one flat object (simpler for every provider), checked against the union above. */
export function proposalToolSchema(kinds: readonly AssistantActionKind[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: kinds },
      title: { type: "string", description: "create_ticket, wiki_draft: one line" },
      description: { type: "string", description: "create_ticket: what is wrong, what was tried, where" },
      priority: { type: "string", enum: TICKET_PRIORITIES, description: "create_ticket" },
      incidentId: { type: "string", description: "acknowledge_incident: the incident's id from a lookup" },
      body: { type: "string", description: "wiki_draft: the page in Markdown" },
      hours: { type: "integer", minimum: 1, maximum: PAUSE_MAX_HOURS, description: "pause_alerts: for how long" },
    },
    required: ["kind"],
    additionalProperties: false,
  };
}

/** The tool's arguments as a payload: keeps only the fields of the chosen kind, then the strict check. */
export function parseProposal(raw: unknown, allowed: readonly AssistantActionKind[]): { ok: true; payload: AssistantProposalPayload } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = r.kind as AssistantActionKind;
  if (!ASSISTANT_ACTION_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${allowed.join(", ")}` };
  if (!allowed.includes(kind)) return { ok: false, error: `${kind} is not something this person may do` };
  const fields: Record<AssistantActionKind, string[]> = {
    create_ticket: ["title", "description", "priority"],
    acknowledge_incident: ["incidentId"],
    wiki_draft: ["title", "body"],
    pause_alerts: ["hours"],
  };
  const picked: Record<string, unknown> = { kind };
  for (const f of fields[kind]) if (r[f] !== undefined && r[f] !== null) picked[f] = r[f];
  const parsed = assistantProposalPayloadSchema.safeParse(picked);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "proposal"}: ${i.message}`).join("; ") };
  return { ok: true, payload: parsed.data };
}

export function assistantActionsFor(permissions: readonly string[]): AssistantActionKind[] {
  return ASSISTANT_ACTION_KINDS.filter((k) => permissions.includes(ASSISTANT_ACTION_PERMISSION[k]));
}

/**
 * The API call a confirmed proposal makes (paths under /api/v1). A wiki draft is a page only its author (and wiki admins)
 * can read: visibility `group` with no groups. Pausing alerts always carries an end time.
 */
export function proposalRequest(p: AssistantProposalPayload): { method: "POST"; path: string; body: Record<string, unknown> | null } {
  switch (p.kind) {
    case "create_ticket":
      return { method: "POST", path: "/tickets", body: { title: p.title, description: p.description, priority: p.priority } };
    case "acknowledge_incident":
      return { method: "POST", path: `/monitors/incidents/${p.incidentId}/ack`, body: null };
    case "wiki_draft":
      return { method: "POST", path: "/wiki", body: { title: p.title, body: p.body, visibility: "group", acl: [] } };
    case "pause_alerts":
      return { method: "POST", path: "/monitors/maintenance", body: { enabled: true, minutes: p.hours * 60 } };
  }
}

/** Plain words for the confirmation card: what pressing Confirm does. */
export function proposalHeadline(p: AssistantProposalPayload): string {
  switch (p.kind) {
    case "create_ticket":
      return "Open a ticket in your name";
    case "acknowledge_incident":
      return "Acknowledge this alert (stops its reminders and escalation; everyone sees it was you)";
    case "wiki_draft":
      return "Save a new wiki page that only you (and wiki admins) can see until you share it";
    case "pause_alerts":
      return `Pause alert notifications for EVERYONE for ${p.hours} hour${p.hours === 1 ? "" : "s"} (incidents are still recorded)`;
  }
}

/** Where the thing an action made lives, from the route's answer (null when there is nothing to open). */
export function proposalResultUrl(p: AssistantProposalPayload, answer: unknown): string | null {
  const id = (answer as { id?: unknown } | null)?.id;
  if (p.kind === "create_ticket" && typeof id === "string") return `/tickets/${id}`;
  if (p.kind === "wiki_draft" && typeof id === "string") return `/wiki/${id}`;
  if (p.kind === "pause_alerts") return "/monitoring";
  return null;
}

/** A proposal's status can only move once: proposed to done or dismissed. */
export function proposalTransitionProblem(from: AssistantProposalStatus, to: AssistantProposalStatus): string | null {
  if (from !== "proposed") return `It was already ${from}.`;
  if (to === "proposed") return "A decision is done or dismissed.";
  return null;
}

/** Whether an answer reads like "I could not find that" (counted on the usage page; the text itself is not shown there). */
export function answerSaysNotFound(text: string): boolean {
  return /\b(could ?n[o']t|cannot|can't|did ?n[o']t|was unable to) (find|locate|see)\b|\bno (matching )?(results?|records?|matches|pages?|tickets?)( (were|was))? found\b|\bnothing (was )?found\b/i.test(text);
}
