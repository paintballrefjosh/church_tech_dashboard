import { Module } from "@nestjs/common";
import { WikiModule } from "../wiki/wiki.module";
import { McpController } from "./mcp.controller";
import { McpToolsService } from "./mcp.tools";

@Module({
  imports: [WikiModule],
  controllers: [McpController],
  providers: [McpToolsService],
})
export class McpModule {}
