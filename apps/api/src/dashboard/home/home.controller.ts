import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { homeQuerySchema, type HomeSnapshot } from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "../../auth/current-user.decorator";
import { HomeService } from "./home.service";

@Controller("dashboard")
export class HomeController {
  constructor(private readonly home: HomeService) {}

  /** Everything the home page shows, as one snapshot. Any signed-in user; read-only. */
  @Get("home")
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, unknown>,
  ): Promise<HomeSnapshot> {
    const parsed = homeQuerySchema.safeParse({ include: query?.include });
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.home.snapshot(user, parsed.data.include);
  }
}
