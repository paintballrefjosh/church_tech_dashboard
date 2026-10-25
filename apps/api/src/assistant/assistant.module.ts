import { Module } from "@nestjs/common";
import { McpModule } from "../mcp/mcp.module";
import { AssistantController } from "./assistant.controller";
import { AssistantService } from "./assistant.service";

/** The assistant. Its lookups go through the MCP route bridge (as the person, by session); everything else is global. */
@Module({ imports: [McpModule], controllers: [AssistantController], providers: [AssistantService] })
export class AssistantModule {}
