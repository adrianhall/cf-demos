import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import { BLUEPRINT_MAP } from '../../blueprints.ts';
import {
  validateCreateDiagramInput,
  validateDiagramId,
  validateUpdateDiagramInput
} from '../domain/diagram-validation.ts';
import type { Diagram, PublicDiagram } from '../domain/diagram.ts';
import { EMPTY_GRAPH_DATA, validateGraphDataInput } from '../domain/graph.ts';
import type { DiagramRepository } from './ports/diagram-repository.ts';
import type { ShareRepository } from './ports/share-repository.ts';

/**
 * Use cases for a user's own diagrams — the tier between the HTTP API and persistence.
 *
 * Two responsibilities live here and nowhere else:
 *
 * - **Validation.** Routes hand this service the raw values they received — a parsed JSON body, a
 *   path parameter — and it validates them through the domain tier before anything reaches storage.
 *   That is what lets the MCP tool layer in a later phase call these same methods with its own
 *   untrusted arguments and get identical rules, as an in-process call rather than an internal HTTP
 *   round trip.
 * - **Authorization.** Every method takes the verified actor and answers `404` for a diagram that
 *   either does not exist or belongs to somebody else. The two cases are deliberately
 *   indistinguishable: a `403` for the second would confirm that a guessed id is real, which turns
 *   the API into an enumeration oracle for other people's diagram ids.
 *
 * The service depends only on {@link DiagramRepository}, never on D1, so the ownership rule is
 * written once, above storage, instead of being repeated in every query.
 */
export class DiagramService {
  /**
   * @param repository Authorization-neutral persistence port backing the diagram directory.
   * @param shares Share persistence port, used only by {@link DiagramService.remove} to cascade.
   *   Deleting a diagram has to stop every link to it resolving, and the cascade belongs to the
   *   delete use case rather than to the route: an MCP tool deleting a diagram in a later phase
   *   must leave exactly the same state behind as the HTTP endpoint does, and it will if there is
   *   only one place that performs the delete at all.
   */
  constructor(
    private readonly repository: DiagramRepository,
    private readonly shares: ShareRepository
  ) {}

  /**
   * Lists the actor's own diagrams, most recently updated first.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @returns That identity's diagrams, newest activity first. Empty when they have none, which is a
   *   successful answer rather than an error.
   * @throws {Error} When the repository cannot read the rows.
   */
  async list(actorEmail: string): Promise<Diagram[]> {
    return this.repository.listByOwner(actorEmail);
  }

  /**
   * Creates a diagram, blank or seeded from a blueprint template.
   *
   * The blueprint is resolved here, against the shared `BLUEPRINT_MAP`, rather than accepted as a
   * graph from the caller. A client names a template; it never supplies graph content at creation
   * time, so creation cannot be used to store a graph that skipped validation.
   *
   * @param actorEmail Verified Cloudflare Access identity that will own the diagram.
   * @param body Unvalidated JSON body from the request.
   * @returns The newly created diagram.
   * @throws {ProblemDetailsError} `badRequest()` (400) or `unprocessableContent()` (422) when the
   *   body is invalid, and `notFound()` (404) when it names a blueprint that does not exist.
   * @throws {Error} When the repository cannot write the row.
   */
  async create(actorEmail: string, body: unknown): Promise<Diagram> {
    const input = validateCreateDiagramInput(body);

    let graphData = EMPTY_GRAPH_DATA;
    if (input.blueprintId !== undefined) {
      const blueprint = BLUEPRINT_MAP.get(input.blueprintId);
      if (blueprint === undefined) {
        // Refused before any write, so a caller probing for template slugs cannot leave a trail of
        // half-created diagrams behind.
        throw notFound({ detail: `Blueprint "${input.blueprintId}" not found.` });
      }
      graphData = blueprint.graphData;
    }

    return this.repository.create(actorEmail, input, graphData);
  }

  /**
   * Reads one of the actor's own diagrams.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @returns The diagram.
   * @throws {ProblemDetailsError} `notFound()` (404) when the id is malformed, no diagram has it,
   *   or the diagram belongs to another identity — all three reported identically.
   * @throws {Error} When the repository cannot read the row.
   */
  async get(actorEmail: string, id: string): Promise<Diagram> {
    return this.requireOwned(actorEmail, id);
  }

  /**
   * Reads a diagram's owner-blind fields, with no actor and therefore no ownership check.
   *
   * Deliberately the only method on this service that takes no actor, and the signature is the
   * documentation: a caller reaching it has already established its own authority some other way,
   * and the projection is narrow enough that it cannot leak whose diagram this is whichever way
   * that was. Two callers qualify today, for different reasons:
   *
   * - {@link ShareService.resolve}, where holding the token _is_ the authorization;
   * - The administrative moderation preview, where the configured administrator has already been
   *   verified by `../middleware/require-admin.ts`.
   *
   * A third caller that is neither would be a mistake, and it is a reviewable one precisely because
   * this method is the only way to read a diagram without naming an actor.
   *
   * @param id Already-validated diagram id. The callers above both validate it; this method does
   *   not repeat the check, because the uniform `404` they each need differs in wording and belongs
   *   to them.
   * @returns The diagram's id, title, description and graph — never its owner.
   * @throws {Error} When the repository cannot read the row.
   */
  async getPublicFields(id: string): Promise<PublicDiagram | null> {
    return this.repository.findPublicFields(id);
  }

  /**
   * Updates one of the actor's own diagrams' title and/or description.
   *
   * The body is validated before the diagram is looked up, so an invalid payload cannot be used to
   * probe which ids exist.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @param body Unvalidated JSON body from the request.
   * @returns The updated diagram.
   * @throws {ProblemDetailsError} `badRequest()` (400) or `unprocessableContent()` (422) when the
   *   body is invalid, and `notFound()` (404) when the diagram is absent or foreign.
   * @throws {Error} When the repository cannot read or write the row.
   */
  async updateMetadata(actorEmail: string, id: string, body: unknown): Promise<Diagram> {
    const input = validateUpdateDiagramInput(body);
    const diagram = await this.requireOwned(actorEmail, id);

    const updated = await this.repository.updateMetadata(diagram.id, input);
    // `null` here means the row disappeared between the ownership read and the write — a
    // concurrent delete by the same owner in another tab. Reporting it as "not found" is the
    // honest answer: by the time the caller reads this, the diagram genuinely is gone.
    if (updated === null) {
      throw notFound({ detail: 'Diagram not found.' });
    }
    return updated;
  }

  /**
   * Replaces one of the actor's own diagrams' graph — the editor's autosave path.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @param body Unvalidated JSON body from the request, carrying `graphData` as a JSON string.
   * @returns The new `updatedAt` timestamp, which the editor shows as its save state.
   * @throws {ProblemDetailsError} `badRequest()` (400) or `unprocessableContent()` (422) when the
   *   body or the decoded graph is invalid, and `notFound()` (404) when the diagram is absent or
   *   foreign.
   * @throws {Error} When the repository cannot read or write the row.
   */
  async saveGraph(actorEmail: string, id: string, body: unknown): Promise<string> {
    const graphData = validateGraphDataInput(body);
    const diagram = await this.requireOwned(actorEmail, id);

    const updatedAt = await this.repository.replaceGraph(diagram.id, graphData);
    if (updatedAt === null) {
      throw notFound({ detail: 'Diagram not found.' });
    }
    return updatedAt;
  }

  /**
   * Duplicates one of the actor's own diagrams.
   *
   * The copy is created with the source's current graph and a suffixed title, and is independent
   * from that moment on: there is no link back to the original, just as a diagram created from a
   * blueprint has no link back to the template.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated id of the diagram to copy.
   * @returns The newly created copy.
   * @throws {ProblemDetailsError} `notFound()` (404) when the source diagram is absent or foreign.
   * @throws {Error} When the repository cannot read or write a row.
   */
  async duplicate(actorEmail: string, id: string): Promise<Diagram> {
    const source = await this.requireOwned(actorEmail, id);

    return this.repository.create(
      actorEmail,
      { description: source.description, title: `${source.title} (copy)` },
      source.graphData
    );
  }

  /**
   * Deletes one of the actor's own diagrams, and with it every share link that pointed at it.
   *
   * The cascade runs only after the delete itself reports a row was removed, which is what stops it
   * becoming a way to revoke somebody else's link by guessing an id: a refused delete never reaches
   * it, and neither does a repeated one.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @returns A promise fulfilled once the diagram no longer exists and no link to it resolves.
   * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is absent or foreign.
   * @throws {Error} When the repository cannot read, delete or revoke a row.
   */
  async remove(actorEmail: string, id: string): Promise<void> {
    const diagram = await this.requireOwned(actorEmail, id);

    await this.removeWithCascade(diagram.id);
  }

  /**
   * Deletes a diagram regardless of who owns it, cascading the same share revocation.
   *
   * The administrative moderation delete, and the one method here that deliberately crosses the
   * ownership boundary. It is named for what it does rather than for who calls it, so that reading
   * a call site makes the absence of an ownership check obvious rather than implied: authorization
   * has already happened in `../middleware/require-admin.ts`, which compares the verified Access
   * identity to the operator-configured `ADMIN_EMAIL` before any administrative route runs.
   *
   * Routing through the same cascade as {@link DiagramService.remove} is the point of putting it
   * here rather than in an administrative service of its own. A moderated diagram must leave
   * exactly the state an owner's own delete leaves — no diagram, and no link that still resolves —
   * and the surest way to guarantee that is for there to be one delete.
   *
   * @param id Unvalidated diagram id from the request path.
   * @returns A promise fulfilled once the diagram no longer exists and no link to it resolves.
   * @throws {ProblemDetailsError} `notFound()` (404) when the id is malformed or no diagram has it.
   *   An administrator gets a plain `404` here because there is genuinely nothing to moderate, not
   *   because the answer is being withheld.
   * @throws {Error} When the repository cannot delete or revoke a row.
   */
  async removeWithoutOwnerCheck(id: string): Promise<void> {
    await this.removeWithCascade(validateDiagramId(id));
  }

  /**
   * Deletes a diagram by id and revokes every share link pointing at it.
   *
   * Private, and the only place either delete performs the actual removal. The cascade belongs to
   * the use case rather than to a route, so an MCP tool deleting a diagram in a later phase leaves
   * the same state behind as the editor and the moderation surface do.
   *
   * @param id Validated diagram id, whose ownership the caller has already decided about.
   * @returns A promise fulfilled once the diagram and every link to it are gone.
   * @throws {ProblemDetailsError} `notFound()` (404) when no row had that id — which also covers a
   *   concurrent delete between an ownership read and this write.
   * @throws {Error} When the repository cannot delete or revoke a row.
   */
  private async removeWithCascade(id: string): Promise<void> {
    if (!(await this.repository.remove(id))) {
      throw notFound({ detail: 'Diagram not found.' });
    }

    // After the delete, deliberately. A link that outlived its diagram would resolve to a `404`
    // from the share service's own existence check anyway, but leaving the record live would mean
    // a deleted diagram still had an "active" share in the operator's data. Running it only after
    // a row was actually removed is also what stops a repeated or refused delete becoming a way to
    // revoke somebody's link.
    await this.shares.revokeAllForDiagram(id, new Date().toISOString());
  }

  /**
   * Resolves a diagram the actor owns, or refuses with the uniform `404`.
   *
   * This is the only place the ownership comparison is written. Every public method above routes
   * through it, so there is no use case that can read or write across the ownership boundary and no
   * second spelling of the rule to keep in step.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @returns The diagram, which the actor owns.
   * @throws {ProblemDetailsError} `notFound()` (404) when the id is malformed, when no diagram has
   *   it, or when the diagram belongs to another identity. The three are reported identically and
   *   the detail is the same string, so the response cannot be used to tell them apart.
   */
  private async requireOwned(actorEmail: string, id: string): Promise<Diagram> {
    const diagram = await this.repository.find(validateDiagramId(id));

    if (diagram === null || diagram.ownerEmail !== actorEmail) {
      throw notFound({ detail: 'Diagram not found.' });
    }
    return diagram;
  }
}
