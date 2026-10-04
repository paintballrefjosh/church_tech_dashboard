import { Controller, Post, Get, Delete, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { startDynamicAudit } from "../audit/audit.decorator";
import { ReadOnlyPerOperation } from "../auth/session-only.decorator";
import { McpToolsService } from "./mcp.tools";

/**
 * MCP server for agents (e.g. a Claude Code session documenting systems in
 * the wiki). Streamable HTTP, stateless: every POST builds a fresh server +
 * transport bound to the caller and answers with plain JSON, so there are no
 * sessions to keep and any API replica can serve any request.
 *
 * Auth is an API token (`Authorization: Bearer`) through the normal
 * SessionGuard, which narrows the user to the token's modules; browser
 * session cookies are refused so a stray tab can't drive the tools. Audit rows come from the tools that change something
 * (recordAuditEntry), not one per MCP call.
 *
 * Connect: claude mcp add --transport http church https://<host>/api/v1/mcp \
 *            --header "Authorization: Bearer <token>"
 */
@Controller("mcp")
export class McpController {
  constructor(private readonly tools: McpToolsService) {}

  // Every MCP call is a POST, reads included, so read-only tokens are let in
  // and McpToolsService refuses their write tools one by one.
  @Post()
  @ReadOnlyPerOperation()
  async handle(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    startDynamicAudit(req);
    if (!user.apiToken) {
      reply
        .code(401)
        .header("www-authenticate", "Bearer")
        .send({ message: "The MCP endpoint needs an API token (Authorization: Bearer …), not a browser session." });
      return;
    }

    const server = this.tools.createServer({ user, req });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    // The transport writes the response itself; take it away from Fastify.
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  }

  /** No server-initiated stream (stateless server): GET and DELETE aren't supported. */
  @Get()
  notAllowedGet(@Res() reply: FastifyReply): void {
    reply.code(405).header("allow", "POST").send({ message: "Use POST" });
  }

  @Delete()
  notAllowedDelete(@Req() req: FastifyRequest, @Res() reply: FastifyReply): void {
    startDynamicAudit(req); // nothing changes, so nothing to audit
    reply.code(405).header("allow", "POST").send({ message: "Use POST" });
  }
}
