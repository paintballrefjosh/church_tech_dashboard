import { Controller, Get, Header } from "@nestjs/common";
import client from "prom-client";
import { PERMISSIONS } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";

client.collectDefaultMetrics();

/**
 * Prometheus scrape endpoint. Not public: process, memory and version figures are reconnaissance for a stranger.
 * Scrape it with a read-only API token from an account in the admin group (`authorization: Bearer cdt_...`,
 * Prometheus `authorization.credentials`).
 */
@Controller()
export class MetricsController {
  @Get("metrics")
  @RequirePermissions(PERMISSIONS.SITE_ADMIN)
  @Header("Content-Type", "text/plain; version=0.0.4")
  async metrics(): Promise<string> {
    return client.register.metrics();
  }
}
