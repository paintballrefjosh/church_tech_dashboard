import { Module } from "@nestjs/common";
import { WikiModule } from "../wiki/wiki.module";
import { McpController } from "./mcp.controller";
import { McpToolsService } from "./mcp.tools";
import { ApiBridge } from "./bridge/api-bridge.service";

@Module({
  imports: [WikiModule],
  controllers: [McpController],
  providers: [McpToolsService, ApiBridge],
})
export class McpModule {}
