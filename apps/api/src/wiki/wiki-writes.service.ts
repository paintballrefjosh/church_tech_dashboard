import { Injectable } from "@nestjs/common";
import type { CreateWikiPageInput, UpdateWikiPageInput } from "@church/shared";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { WikiService } from "./wiki.service";

/**
 * Page create/update plus their side effects (realtime events, the
 * page-change notification fan-out), shared by the REST controller and the
 * MCP tools so both paths behave identically. WikiService itself handles
 * revisions, search indexing and @mention notifications.
 */
@Injectable()
export class WikiWritesService {
  constructor(
    private readonly wiki: WikiService,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
  ) {}

  async createPage(user: AuthenticatedUser, input: CreateWikiPageInput) {
    const page = await this.wiki.create(user, input);
    this.realtime.toUser(user.id, "wiki:created", page);
    return page;
  }

  async updatePage(
    user: AuthenticatedUser,
    id: string,
    input: UpdateWikiPageInput,
    opts: { expectedUpdatedAt?: Date } = {},
  ) {
    const page = await this.wiki.update(user, id, input, opts);
    this.realtime.toRoom(`wiki:${id}`, "wiki:updated", page);

    // Notify the owner + everyone with ACL access (excluding the actor). We
    // skip email here — wiki edits can be high-volume and notifications
    // already show up in the bell + (if open) the page room. Cheaper for the
    // SMTP relay and friendlier to the recipient's inbox.
    const recipients = await this.wiki.recipientsForPageChange(id);
    void this.notifications.createMany(
      recipients.map((rid) => ({
        recipientUserId: rid,
        kind: "wiki.updated",
        title: `Wiki page updated: ${page.title}`,
        body: input.summary ?? "",
        link: `/wiki/${page.id}`,
        excludeActorId: user.id,
        email: false,
      })),
    );
    return page;
  }
}
