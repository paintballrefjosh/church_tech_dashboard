import { Controller, Get, NotFoundException } from "@nestjs/common";
import { ALERT_KEYS, publicStatusPage, type PublicStatusPage } from "@church/shared";
import { Public } from "../auth/public.decorator";
import { SettingsService } from "../settings/settings.service";
import { TtlCache } from "../dashboard/home/cache";
import { StatusService } from "./status.service";

/** How long the public copy is reused: anyone on the internet may ask for it, so it must not cost a query each time. */
const PUBLIC_TTL_MS = 15_000;

/** Any signed-in person (the session guard still applies); no module permission, by design. */
@Controller("status")
export class StatusController {
  private readonly publicCache = new TtlCache(Date.now, 4);

  constructor(
    private readonly status: StatusService,
    private readonly settings: SettingsService,
  ) {}

  @Get()
  page() {
    return this.status.page();
  }

  /**
   * The same page for people who are not signed in, only while `monitoring.status_public` is on (404 otherwise, the same
   * answer as for a path that does not exist). Without the internal monitor ids; cached for a few seconds.
   */
  @Public()
  @Get("public")
  async publicPage(): Promise<PublicStatusPage> {
    if ((await this.settings.get(ALERT_KEYS.statusPublic)) !== true) throw new NotFoundException();
    return this.publicCache.get("page", PUBLIC_TTL_MS, async () => publicStatusPage(await this.status.page()));
  }
}
