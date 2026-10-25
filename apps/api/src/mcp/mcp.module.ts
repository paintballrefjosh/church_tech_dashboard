import { Module } from "@nestjs/common";
import { WikiModule } from "../wiki/wiki.module";
import { McpController } from "./mcp.controller";
import { McpToolsService } from "./mcp.tools";
import { ApiBridge } from "./bridge/api-bridge.service";

@Module({
  imports: [WikiModule],
  controllers: [McpController],
  providers: [McpToolsService, ApiBridge],
  // The assistant runs its lookups through the same bridge, as the signed-in person.
  exports: [ApiBridge],
})
export class McpModule {}
