import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { PERMISSIONS, siteToday } from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/permissions.decorator";
import { SessionOnly } from "../auth/session-only.decorator";
import { Audited, recordAuditEntry, startDynamicAudit } from "../audit/audit.decorator";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import { AssistantService, type AssistantEvent } from "./assistant.service";

const chatBody = z.object({ conversationId: z.string().uuid().optional(), question: z.string().trim().min(1).max(4000) }).strict();
const feedbackBody = z.object({ rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().trim().max(1000).default("") }).strict();
const decideBody = z.object({ status: z.enum(["done", "dismissed"]), resultUrl: z.string().max(500).nullable().default(null) }).strict();

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

/**
 * The assistant (docs/assistant.md). Session only throughout: an API token cannot spend the budget, and the lookups run
 * with the person's own session. Configuration is site administration; using it is the `assistant` module.
 */
@Controller("assistant")
@SessionOnly()
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

  /** For the web: is it on, and may this person use it. No permission needed to ask. */
  @Get("status")
  async status(@CurrentUser() user: AuthenticatedUser) {
    const c = await this.assistant.config();
    // `health` says only whether it works (no figures), for the chat page and the Services banner.
    return { enabled: c.enabled, canUse: user.permissions.includes(PERMISSIONS.ASSISTANT_USE), health: c.enabled ? await this.assistant.health() : null };
  }

  /**
   * Ask. Answers with server-sent events (`data: <json>` lines: conversation, text, lookup, done, error) and a comment
   * every 15 s so a load balancer does not close a quiet stream. Closing the request stops the answer.
   */
  @Post("chat")
  @RequirePermissions(PERMISSIONS.ASSISTANT_USE)
  async chat(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    startDynamicAudit(req);
    const parsed = chatBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const abort = new AbortController();
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", connection: "keep-alive" });
    raw.on("close", () => abort.abort());
    const send = (e: AssistantEvent) => {
      if (!raw.writableEnded) raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const keepAlive = setInterval(() => !raw.writableEnded && raw.write(": keep-alive\n\n"), 15_000);
    try {
      const outcome = await this.assistant.ask(user, parsed.data, { sessionCookie: String(req.headers.cookie ?? ""), ip: req.ip ?? null }, send, abort.signal);
      recordAuditEntry(req, {
        action: "assistant.chat",
        resourceType: "assistant_conversation",
        resourceId: outcome.conversationId,
        after: { model: outcome.model, outcome: outcome.outcome, lookups: outcome.lookups, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens },
      });
    } catch (err) {
      send({ type: "error", kind: "error", message: (err as { message?: string }).message ?? "Something went wrong." });
    } finally {
      clearInterval(keepAlive);
      if (!raw.writableEnded) raw.end();
    }
  }

  @Get("conversations")
  @RequirePermissions(PERMISSIONS.ASSISTANT_USE)
  conversations(@CurrentUser() user: AuthenticatedUser) {
    return this.assistant.conversations(user);
  }

  @Get("conversations/:id")
  @RequirePermissions(PERMISSIONS.ASSISTANT_USE)
  conversation(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.assistant.conversation(user, id);
  }

  @Delete("conversations/:id")
  @RequirePermissions(PERMISSIONS.ASSISTANT_USE)
  @Audited({ action: "assistant.conversation.delete", resourceType: "assistant_conversation", resourceIdFromParams: (p) => p.id ?? null })
  async deleteConversation(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    await this.assistant.deleteConversation(user, id);
    return { ok: true };
  }

  /** Thumbs up or down on one of your own answers. The comment stays with the conversation; the audit row has the rating only. */
  @Post("messages/:id/feedback")
  @RequirePermissions(PERMISSIONS.ASSISTANT_USE)
  @Audited({ action: "assistant.feedback", resourceType: "assistant_message", resourceIdFromParams: (p) => p.id ?? null, redactKeys: ["comment"] })
  feedback(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(feedbackBody, body);
    return this.assistant.feedback(user, id, b.rating, b.comment);
  }

  /**
   * Records the decision on a proposed action. It never acts: on Confirm the page has already called the action's own
   * route as the person (audited there); this keeps the conversation truthful about what happened.
   */
  @Patch("messages/:id/actions/:actionId")
  @RequirePermissions(PERMISSIONS.ASSISTANT_USE)
  @Audited({ action: "assistant.action.decide", resourceType: "assistant_message", resourceIdFromParams: (p) => p.id ?? null })
  decide(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string, @Param("actionId", ParseUUIDPipe) actionId: string, @Body() body: unknown) {
    const b = parse(decideBody, body);
    return this.assistant.decideAction(user, id, actionId, b.status, b.resultUrl);
  }

  // ---- site administration ----

  /** The checklist that must be green before it can be switched on, with the last test and the privacy acknowledgement. */
  @Get("admin/readiness")
  @RequirePermissions(PERMISSIONS.SITE_ADMIN)
  async readiness() {
    const r = await this.assistant.readiness();
    return { ready: r.ready, items: r.items, lastTest: r.lastTest, privacy: r.privacy, destination: r.destination, enabled: r.config.enabled };
  }

  @Post("admin/test")
  @RequirePermissions(PERMISSIONS.SITE_ADMIN)
  @Audited({ action: "assistant.test", resourceType: "assistant" })
  test() {
    return this.assistant.test();
  }

  @Post("admin/privacy")
  @RequirePermissions(PERMISSIONS.SITE_ADMIN)
  @Audited({ action: "assistant.privacy.acknowledge", resourceType: "assistant" })
  acknowledge(@CurrentUser() user: AuthenticatedUser) {
    return this.assistant.acknowledgePrivacy(user);
  }

  /** Questions, tokens and cost this month (no conversation text). */
  @Get("admin/usage")
  @RequirePermissions(PERMISSIONS.ASSISTANT_USAGE)
  async usage() {
    return this.assistant.usage(siteToday(new Date(), await this.delivery.zone()));
  }
}
