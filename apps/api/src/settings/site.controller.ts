import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { SettingsService } from "./settings.service";

/**
 * Public-facing site identity. The web app's TopBar (which renders on signed-out
 * pages too) needs to read these values without an auth round-trip, so this
 * endpoint is intentionally @Public — but only ever returns the small handful
 * of strings that appear in the UI chrome anyway.
 *
 * If you add more values here, keep them visible-to-everyone things (name,
 * tagline) — not anything secret.
 */
@Controller("site")
export class SiteController {
  constructor(private readonly settings: SettingsService) {}

  @Public()
  @Get("identity")
  async identity(): Promise<{ name: string; tagline: string }> {
    const [name, tagline] = await Promise.all([
      this.settings.get("site.name"),
      this.settings.get("site.tagline"),
    ]);
    return {
      name: typeof name === "string" && name.trim() ? name : "Church Dashboard",
      tagline: typeof tagline === "string" ? tagline : "",
    };
  }
}
