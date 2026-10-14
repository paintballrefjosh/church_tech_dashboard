import { SetMetadata } from "@nestjs/common";

export const OPERATIONAL_ONLY_KEY = "auth:operationalOnly";

/**
 * Mark a route that acts on live equipment or services outside the dashboard (a switch port, a DNS
 * record, a network scan, the projector). An API-token (bearer) request is refused with 403 unless the
 * token was created with the operational level; a signed-in browser session is not affected. A token
 * can only reach this level when it is not read-only. The MCP catalogue's `operational` tools must be
 * exactly the routes that carry this decorator (mcp-coverage.test.ts).
 */
export const OperationalOnly = () => SetMetadata(OPERATIONAL_ONLY_KEY, true);
