/**
 * Owner-visible invitation record.
 *
 * Deliberately excludes the raw token (returned only once, by `CreateInvitationResult`) and the
 * D1 `token_digest` column (never returned to a browser at all — see `./repository.ts`).
 */
export interface InvitationSummary {
  /** Opaque, non-secret identifier used to list/revoke this invitation. Not the token or its digest. */
  id: string;
  /** Diagram this invitation grants editor access to. */
  diagramId: string;
  /** Verified Cloudflare Access email of the diagram owner who created this invitation. */
  creatorEmail: string;
  /** ISO-8601 timestamp after which this invitation can no longer be redeemed. */
  expiresAt: string;
}

/** `InvitationRepository.create()`'s result: the persisted summary plus the one-time raw token. */
export interface CreateInvitationResult {
  /** The persisted, non-secret invitation record. */
  invitation: InvitationSummary;
  /**
   * The raw invitation token, returned to the owner exactly once.
   *
   * Never persisted or logged — only its SHA-256 digest lives in D1 (`diagram_invites.token_digest`).
   */
  token: string;
}

/** Validated `POST /api/invitations/redeem` request body. */
export interface RedeemInvitationInput {
  /** Raw invitation token submitted by the caller. */
  token: string;
}
