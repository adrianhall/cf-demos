import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import { generateShareToken, shareTokenDigest, validateShareToken } from '../domain/share-token.ts';
import type { CreatedShare, SharedDiagram, ShareStatus } from '../domain/share.ts';
import type { DiagramService } from './diagram-service.ts';
import type { ShareRepository } from './ports/share-repository.ts';

/**
 * Detail used by every share refusal.
 *
 * One string, used for a malformed token, an unknown token, a revoked token and a diagram that has
 * since been deleted. The statuses are already identical; sharing the detail is what stops the
 * response body becoming the oracle the status code deliberately is not.
 */
const SHARE_NOT_FOUND = 'Share link not found or revoked.';

/**
 * Use cases for read-only diagram sharing.
 *
 * Two postures meet in this one service, and keeping them in one place is deliberate — the rules
 * that separate them are easier to review together than apart:
 *
 * - **Owner-only management.** Status, rotation and revocation each take a verified actor and
 *   delegate the ownership question to {@link DiagramService}, so a share operation can never reach
 *   a diagram an ordinary read could not. The refusal is the same uniform `404`.
 * - **Anonymous resolution.** {@link ShareService.resolve} takes no actor at all, because a share
 *   link is a bearer capability: holding the token _is_ the authorization. It answers with a
 *   projection that cannot name the diagram's owner.
 *
 * The raw token is handled only here and in the domain module that mints it. It is generated,
 * hashed, and returned to the caller; the digest is what travels onward to the repository. Nothing
 * in this file passes a token to a port, a log or any response other than the creation result.
 */
export class ShareService {
  /**
   * @param repository Authorization-neutral persistence port for shares.
   * @param diagrams Diagram use cases, used solely for its ownership rule. Depending on the service
   *   rather than on the diagram repository is what keeps that rule written once: a second
   *   `ownerEmail !== actor` comparison here would be a second thing to keep in step, and the one
   *   most likely to be forgotten when the rule grows a collaborator clause in a later phase.
   */
  constructor(
    private readonly repository: ShareRepository,
    private readonly diagrams: DiagramService
  ) {}

  /**
   * Reports whether one of the actor's own diagrams currently has an active share link.
   *
   * Never returns the link. Only a digest is stored, so the server cannot reproduce it — see
   * {@link ShareStatus}.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param diagramId Unvalidated diagram id from the request path.
   * @returns The diagram's current share status.
   * @throws {ProblemDetailsError} `notFound()` (404) when the id is malformed, unknown or belongs
   *   to another identity — all three reported identically.
   * @throws {Error} When the repository cannot read the rows.
   */
  async getStatus(actorEmail: string, diagramId: string): Promise<ShareStatus> {
    const diagram = await this.diagrams.get(actorEmail, diagramId);
    const active = await this.repository.findActive(diagram.id);

    return active === null
      ? { active: false, createdAt: null }
      : { active: true, createdAt: active.createdAt };
  }

  /**
   * Mints a share link for one of the actor's own diagrams, replacing any link already active.
   *
   * Rotation rather than accumulation: an owner who mints a second link has almost always lost the
   * first, and leaving both working would mean a link they can no longer see is still handing out
   * their diagram. Revoking first makes "revoke" a complete action rather than a per-link one.
   *
   * This is the only method in the application that returns a raw token, and its result is the only
   * moment the token exists outside the caller's own memory.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param diagramId Unvalidated diagram id from the request path.
   * @returns The new token and its creation timestamp.
   * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is malformed, unknown or
   *   foreign — refused before anything is minted, so guessing ids cannot create shares.
   * @throws {Error} When the repository cannot read or write the rows.
   */
  async rotate(actorEmail: string, diagramId: string): Promise<CreatedShare> {
    const diagram = await this.diagrams.get(actorEmail, diagramId);
    const now = new Date().toISOString();

    await this.repository.revokeActive(diagram.id, now);

    const token = generateShareToken();
    await this.repository.create(diagram.id, await shareTokenDigest(token), now);

    return { createdAt: now, token };
  }

  /**
   * Revokes the active share link on one of the actor's own diagrams.
   *
   * A diagram with no active link is reported as `404` rather than succeeding quietly. The owner
   * asked about a link that is not there, and that is the same answer every other absent share
   * gets.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param diagramId Unvalidated diagram id from the request path.
   * @returns A promise fulfilled once the link no longer resolves.
   * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is malformed, unknown or
   *   foreign, or when it has no active link.
   * @throws {Error} When the repository cannot read or write the rows.
   */
  async revoke(actorEmail: string, diagramId: string): Promise<void> {
    const diagram = await this.diagrams.get(actorEmail, diagramId);

    if (!(await this.repository.revokeActive(diagram.id, new Date().toISOString()))) {
      throw notFound({ detail: 'No active share link for this diagram.' });
    }
  }

  /**
   * Resolves a share token to the diagram's public, read-only fields.
   *
   * Takes no actor, because there is none: this is the one use case in the application reached by
   * an anonymous caller, and the token is the whole of the authorization. The returned projection
   * omits the owner by construction (see {@link SharedDiagram}), and is read at request time rather
   * than from a snapshot, so an edit made after the link was shared is visible through it
   * immediately.
   *
   * @param token Raw token presented by an anonymous caller.
   * @returns The diagram's public fields.
   * @throws {ProblemDetailsError} `notFound()` (404) when the token is malformed, unknown, revoked,
   *   or points at a diagram that has since been deleted. All four carry the same detail, so a
   *   caller cannot tell them apart and cannot use the endpoint to probe for live links.
   * @throws {Error} When the repository cannot read the rows.
   */
  async resolve(token: string): Promise<SharedDiagram> {
    const digest = await shareTokenDigest(validateShareToken(token));

    const diagramId = await this.repository.resolve(digest);
    if (diagramId === null) {
      throw notFound({ detail: SHARE_NOT_FOUND });
    }

    // Checked rather than assumed. The diagram delete use case cascades a revocation, so a share
    // pointing at a missing diagram should not occur — but "should not occur" is not a reason to
    // serve `null` into a response, and a cascade that failed halfway must still refuse here.
    const shared = await this.repository.findSharedDiagram(diagramId);
    if (shared === null) {
      throw notFound({ detail: SHARE_NOT_FOUND });
    }
    return shared;
  }
}
