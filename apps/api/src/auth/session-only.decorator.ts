import { SetMetadata } from "@nestjs/common";

export const SESSION_ONLY_KEY = "auth:sessionOnly";

/**
 * Refuse API-token (bearer) requests on this route or controller: it needs a
 * signed-in browser session. For anything that could let a leaked token
 * outlive its revocation or take over the account: minting or revoking
 * tokens, changing the password, email or 2FA.
 */
export const SessionOnly = () => SetMetadata(SESSION_ONLY_KEY, true);
