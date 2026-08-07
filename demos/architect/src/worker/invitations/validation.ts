import {
  badRequest,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import { isWellFormedInvitationToken } from "./token";
import type { RedeemInvitationInput } from "./types";

/**
 * Validate `POST /api/invitations/redeem`'s request body (`{ "token": "..." }`).
 *
 * A malformed token (wrong shape) is rejected here, before it is ever hashed or looked up in D1
 * — see `./repository.ts`'s `redeem()` for the separate "well-formed but unknown/expired/
 * revoked/already-redeemed" cases, which this validation cannot detect.
 *
 * @param value Parsed JSON body.
 * @returns Validated redemption input.
 * @throws {ProblemDetailsError} `badRequest()` when the body is not a JSON object;
 * `unprocessableContent()` when `token` is missing or is not shaped like a real invitation token.
 */
export function validateRedeemInvitationInput(
  value: unknown,
): RedeemInvitationInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest({ detail: "The request body must be an object." });
  }
  const { token } = value as Record<string, unknown>;
  if (typeof token !== "string" || !isWellFormedInvitationToken(token)) {
    throw unprocessableContent({ detail: "token is malformed." });
  }
  return { token };
}
