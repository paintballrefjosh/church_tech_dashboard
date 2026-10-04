import { SetMetadata } from "@nestjs/common";

export const SESSION_ONLY_KEY = "auth:sessionOnly";

/**
 * Refuse API-token (bearer) requests on this route or controller: it needs a
 * signed-in browser session. For anything that could let a leaked token
 * outlive its revocation or take over the account: minting or revoking
 * tokens, changing the password, email or 2FA.
 */
export const SessionOnly = () => SetMetadata(SESSION_ONLY_KEY, true);

export const READ_ONLY_PER_OPERATION_KEY = "auth:readOnlyPerOperation";

/**
 * Let read-only API tokens reach a non-GET route that multiplexes reads and
 * writes over one method (the MCP endpoint: every call is a POST). The route
 * must then refuse writes itself (`user.apiToken.readOnly`); SessionGuard
 * otherwise rejects every non-GET request from a read-only token.
 */
export const ReadOnlyPerOperation = () => SetMetadata(READ_ONLY_PER_OPERATION_KEY, true);
