import { Injectable, Inject, Logger } from "@nestjs/common";
import { and, inArray, isNull, or, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { users } from "../db/schema";
import { NotificationsService } from "../notifications/notifications.service";
import { AuthService } from "../auth/auth.service";
import type { AuthenticatedUser } from "../auth/current-user.decorator";

/** At most this many distinct handles are looked up per body: one comment must not be able to email everyone. */
export const MAX_MENTIONS = 20;

/**
 * @mention parser + notifier. Two recognised syntaxes:
 *   `@username` — local-part of an "@local" email, e.g. `@josh`
 *   `@"Display Name"` — exact match against users.name
 *
 * Anything that doesn't resolve to a real user is left as-is and silently
 * ignored. We never error out a save just because a mention is wrong.
 */
@Injectable()
export class MentionsService {
  private readonly logger = new Logger(MentionsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Extract candidate handles from a body of text. Returns the de-duped set
   * of literal strings as they appeared after the @ — used to look up users.
   */
  static parse(text: string): string[] {
    const out = new Set<string>();
    // @"quoted display name" — captures the inside of the quotes
    for (const m of text.matchAll(/@"([^"\n]{1,80})"/g)) {
      if (m[1]) out.add(m[1].trim());
    }
    // @bareword — captures up to whitespace / punctuation, max 64 chars.
    // We deliberately allow dots so `@user@local`-style emails parse as a single
    // mention if the user types one; the lookup then handles both forms.
    for (const m of text.matchAll(/(?:^|\s)@([A-Za-z0-9._-]{1,64})/g)) {
      if (m[1]) out.add(m[1]);
    }
    return [...out].slice(0, MAX_MENTIONS);
  }

  /**
   * Resolve handles to user rows. Matches local-part (`josh` → `josh@local`),
   * full email, or exact display name (case-insensitive). Returns each user
   * once.
   *
   * Implementation: three index-friendly `inArray(lower(col), values)`
   * lookups instead of an OR-of-ILIKEs that would force a full scan.
   * Expression indexes on `users(lower(email))` and `users(lower(name))`
   * (migration 0026) make each query an index seek.
   */
  async resolve(handles: string[]): Promise<{ id: string; email: string; name: string | null }[]> {
    if (handles.length === 0) return [];
    const lower = handles.map((h) => h.toLowerCase());
    // Each handle could be an email, a local-part (`josh` → `josh@*`), or a
    // display name. We materialise both possible email forms.
    const emails = lower.filter((h) => h.includes("@"));
    const localParts = lower.filter((h) => !h.includes("@"));
    const localPartEmails = localParts.map((h) => `${h}@local`);
    const emailCandidates = [...emails, ...localPartEmails];

    const rows = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(
        and(
          or(
            emailCandidates.length
              ? inArray(sql`lower(${users.email})`, emailCandidates)
              : undefined,
            lower.length ? inArray(sql`lower(${users.name})`, lower) : undefined,
          )!,
          isNull(users.deletedAt),
        ),
      );
    // De-dupe — a user can match by both email and name on different handles.
    const seen = new Set<string>();
    const out: { id: string; email: string; name: string | null }[] = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out;
  }

  /**
   * Parse the body, resolve mentions, fan out notifications. excludeUserId
   * is the actor (usually @CurrentUser.id) so authors don't notify themselves.
   *
   * `canSee` decides, per mentioned person, whether they may read what the text is in: the notification carries the
   * text itself (in-app and by email), so a mention in an internal ticket note or on a restricted wiki page must never
   * reach someone who could not open it. Disabled, deleted and pending accounts are never notified.
   */
  async notify(opts: {
    body: string;
    excludeUserId: string;
    title: string;
    summary: string;
    link: string;
    canSee: (user: AuthenticatedUser) => boolean | Promise<boolean>;
  }): Promise<void> {
    const handles = MentionsService.parse(opts.body);
    if (handles.length === 0) return;
    let users: { id: string; email: string; name: string | null }[] = [];
    try {
      users = await this.resolve(handles);
    } catch (err) {
      this.logger.warn(`mention resolve failed: ${(err as Error).message}`);
      return;
    }
    const allowed: string[] = [];
    for (const u of users) {
      if (u.id === opts.excludeUserId) continue;
      try {
        const loaded = await this.auth.loadUserById(u.id);
        if (!loaded || loaded.approvalStatus === "pending") continue;
        if (await opts.canSee(loaded)) allowed.push(u.id);
      } catch (err) {
        this.logger.warn(`mention access check failed: ${(err as Error).message}`);
      }
    }
    if (allowed.length === 0) return;
    // Fan out in one batch: createMany does a single recipient lookup + one
    // INSERT instead of N×(lookup+insert).
    const body = opts.summary.slice(0, 280);
    try {
      await this.notifications.createMany(
        allowed.map((id) => ({
          recipientUserId: id,
          kind: "mention" as const,
          title: opts.title,
          body,
          link: opts.link,
          excludeActorId: opts.excludeUserId,
        })),
      );
    } catch (err) {
      // Callers fire and forget; a failed notice must not become an unhandled rejection.
      this.logger.warn(`mention notify failed: ${(err as Error).message}`);
    }
  }
}
