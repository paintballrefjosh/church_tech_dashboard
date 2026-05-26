import { Controller, Get, Header } from "@nestjs/common";
import client from "prom-client";
import { Public } from "../auth/public.decorator";

client.collectDefaultMetrics();

@Controller()
export class MetricsController {
  @Public()
  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4")
  async metrics(): Promise<string> {
    return client.register.metrics();
  }
}
