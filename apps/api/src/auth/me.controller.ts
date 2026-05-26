import { Controller, Get } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "./current-user.decorator";

@Controller("me")
export class MeController {
  @Get()
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
