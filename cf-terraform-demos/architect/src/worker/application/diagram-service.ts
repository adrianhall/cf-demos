import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import { problemDetails } from '@adrianhall/cloudflare-toolkit/problem-details';
import { BLUEPRINT_MAP } from '../../blueprints.ts';
import type { AccessibleDiagram } from '../domain/collaborator.ts';
import {
  validateCreateDiagramInput,
  validateDiagramId,
  validateUpdateDiagramInput
} from '../domain/diagram-validation.ts';
import type { Diagram, PublicDiagram } from '../domain/diagram.ts';
import type { GraphOperation } from '../domain/graph-operations.ts';
import { EMPTY_GRAPH_DATA, validateGraphDataInput } from '../domain/graph.ts';
import type { CollaboratorService } from './collaborator-service.ts';
import type { DiagramRepository } from './ports/diagram-repository.ts';
import type {
  AppliedGraphWrite,
  DiagramSessionPort,
  GraphWriteOutcome
} from './ports/diagram-session.ts';
import type { ShareRepository } from './ports/share-repository.ts';

/**
 * The widened access rule this service borrows, and no more of the collaboration surface.
 *
 * Narrowed with `Pick` rather than taking the whole {@link CollaboratorService}, so granting or
 * revoking edit access can never be reached from a diagram use case. The rule itself is written
 * once, in `./collaborator-service.ts`; this service calls it rather than restating it, which is
 * what keeps "a collaborator may read this" from acquiring a second spelling that could drift from
 * the first.
 */
type DiagramAccessRule = Pick<CollaboratorService, 'requireAccessible'>;

/**
 * Turns a session's write outcome back into either its result or the thrown problem document the
 * rest of the application expects.
 *
 * The session reports a refusal as a **value** because a thrown error loses its status crossing an
 * RPC boundary — see `./ports/diagram-session.ts`. This is the one place that conversion is undone,
 * so every transport above it keeps the error contract it already had: an MCP tool call and an HTTP
 * request refusing a stale node both answer `404`, with the same detail, exactly as they did when
 * the mutation ran in this tier.
 *
 * @param outcome What the session reported.
 * @returns The applied write, when one happened.
 * @throws {ProblemDetailsError} Carrying the status and detail the session chose: `404` for a stale
 *   target or a diagram deleted mid-write, `400` for a duplicate element id, `422` for a graph that
 *   fails canonical validation, `500` for a storage failure.
 */
function requireApplied(outcome: GraphWriteOutcome): AppliedGraphWrite {
  if (outcome.outcome === 'rejected') {
    throw problemDetails({ detail: outcome.detail, status: outcome.status });
  }
  return outcome;
}

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
 *   either does not exist or is one the actor may not reach. The two cases are deliberately
 *   indistinguishable: a `403` for the second would confirm that a guessed id is real, which turns
 *   the API into an enumeration oracle for other people's diagram ids.
 *
 * ## Two access rules, deliberately
 *
 * Now that collaborators exist, "may this actor reach this diagram?" has two answers depending on
 * what they are trying to do, and this service keeps both rather than widening one:
 *
 * - {@link DiagramService.requireOwned} — the narrow rule, unchanged. The actor must own the diagram.
 *   Rename, delete, duplicate, share-link management and collaborator management all keep it,
 *   because each decides what the diagram _is_ or who may reach it, rather than what it contains.
 * - {@link DiagramAccessRule} — the widened rule, borrowed from `./collaborator-service.ts` rather
 *   than restated here. Owner or editor. Exactly three surfaces use it: reading a diagram, saving
 *   its graph, and opening its live session — which is what collaborating on a document means.
 *
 * Which rule a method is held to is visible on its first line, and keeping two named rules rather
 * than one with a flag is what makes that readable.
 *
 * The service depends only on ports and that one borrowed rule, never on D1, so both rules live
 * above storage instead of being repeated in every query.
 */
export class DiagramService {
  /**
   * @param repository Authorization-neutral persistence port backing the diagram directory.
   * @param shares Share persistence port, used only by {@link DiagramService.remove} to cascade.
   *   Deleting a diagram has to stop every link to it resolving, and the cascade belongs to the
   *   delete use case rather than to the route: an MCP tool deleting a diagram in a later phase
   *   must leave exactly the same state behind as the HTTP endpoint does, and it will if there is
   *   only one place that performs the delete at all.
   * @param sessions Live-session coordination port — since this phase, the **one serialized path
   *   every graph write takes**, as well as the way an authorized editor connection is opened. This
   *   service no longer writes a graph to the repository at all, which is what closes the
   *   lost-update race between the editor's autosave and an agent's tool call. An interface rather
   *   than a Durable Object namespace, so this service — and every test of it — stays independent
   *   of the coordination product; see `./ports/diagram-session.ts`.
   * @param access The widened owner-or-editor rule; see {@link DiagramAccessRule}. Injected rather
   *   than implemented here, so there is exactly one definition of "may reach this diagram" and
   *   this service cannot drift from the service that manages the grants it depends on.
   */
  constructor(
    private readonly repository: DiagramRepository,
    private readonly shares: ShareRepository,
    private readonly sessions: DiagramSessionPort,
    private readonly access: DiagramAccessRule
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
   * Reads a diagram the actor owns or collaborates on.
   *
   * One of the three methods held to the widened rule rather than the narrow one. Reading is the
   * minimum a collaborator must be able to do — a grant that did not permit it would permit nothing
   * — so this is where the two rules first diverge.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @returns The diagram.
   * @throws {ProblemDetailsError} `notFound()` (404) when the id is malformed, no diagram has it,
   *   or the actor neither owns it nor holds a grant on it — all three reported identically.
   * @throws {Error} When a repository cannot read its rows.
   */
  async get(actorEmail: string, id: string): Promise<Diagram> {
    return (await this.access.requireAccessible(actorEmail, id)).diagram;
  }

  /**
   * Reads a diagram the actor **owns**, refusing a collaborator with the same uniform `404`.
   *
   * The narrow-rule sibling of {@link DiagramService.get}, and it exists because widening `get`
   * silently widened everything built on it. Two callers need the narrow rule and would otherwise
   * have inherited the wide one without anybody deciding to:
   *
   * `./share-service.ts` is the principal caller: its status, rotation and revocation are
   * owner-only. A collaborator who could mint a public read-only link to somebody else's diagram
   * would be handing out access the owner never granted and cannot see. MCP graph reads and exports
   * deliberately use the wider {@link DiagramService.get} now, matching the collaborator's browser
   * authority; administrative MCP tools continue to reach narrow methods such as metadata update
   * and removal.
   *
   * Naming it, rather than leaving those callers on a `get` that quietly changed meaning, is the
   * point: the narrow rule is now something a call site asks for.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @returns The diagram, which the actor owns.
   * @throws {ProblemDetailsError} `notFound()` (404) when the id is malformed, no diagram has it,
   *   or the actor is anything other than its owner — including a collaborator on it.
   * @throws {Error} When the repository cannot read the row.
   */
  async getOwned(actorEmail: string, id: string): Promise<Diagram> {
    return this.requireOwned(actorEmail, id);
  }

  /**
   * Reads a diagram the actor owns or collaborates on, with the role they hold on it.
   *
   * The same read as {@link DiagramService.get}, keeping the role the rule already determined. It
   * exists for one caller: the editor's own load, where the client needs to know whether to offer
   * owner-only controls. Deriving that from a second request would be a second answer that could
   * disagree with this one.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @returns The diagram and the actor's role on it.
   * @throws {ProblemDetailsError} `notFound()` (404) under exactly the conditions
   *   {@link DiagramService.get} refuses.
   * @throws {Error} When a repository cannot read its rows.
   */
  async getAccessible(actorEmail: string, id: string): Promise<AccessibleDiagram> {
    return this.access.requireAccessible(actorEmail, id);
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
   * Replaces the graph of a diagram the actor owns or collaborates on — the editor's autosave.
   *
   * The second of the three widened methods, and the one that makes a grant mean "edit" rather than
   * "view". Note what stays narrow alongside it: a collaborator may replace this diagram's contents
   * but cannot rename or delete it, which is the whole of the distinction between editing a
   * document and administering it.
   *
   * The row is still written by id, and the stored `ownerEmail` is untouched: a collaborator's save
   * does not transfer ownership, and nothing here lets it.
   *
   * Since this phase the write goes through the live session rather than to the repository, so the
   * editor's autosave is serialized against every other writer instead of racing them. The route
   * behind it is now explicitly a **resilience fallback**: it is how a tab whose socket is not
   * connected still saves. A connected editor sends granular operations over its socket instead.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @param body Unvalidated JSON body from the request, carrying `graphData` as a JSON string.
   * @returns The new `updatedAt` timestamp, which the editor shows as its save state.
   * @throws {ProblemDetailsError} `badRequest()` (400) or `unprocessableContent()` (422) when the
   *   body or the decoded graph is invalid, `notFound()` (404) when the diagram is absent, the
   *   actor may not reach it, or it was deleted while the save was in flight, and
   *   `internalServerError()` (500) when the write itself failed.
   * @throws {Error} When a repository cannot read its rows, or the session cannot be reached.
   */
  async saveGraph(actorEmail: string, id: string, body: unknown): Promise<string> {
    const graphData = validateGraphDataInput(body);
    const { diagram } = await this.access.requireAccessible(actorEmail, id);

    // Through the session rather than straight to the repository, which is the change this phase
    // makes. The autosave is no longer an independent writer that could overwrite an agent's
    // change it never saw: it takes its turn in the same queue as every other write.
    return requireApplied(await this.sessions.replaceGraph(diagram.id, graphData, actorEmail))
      .updatedAt;
  }

  /**
   * Applies one granular operation to a diagram's graph — the MCP tools' only write path.
   *
   * Two steps, and the division between them is the point of this phase:
   *
   * 1. **Resolve an accessible diagram**, through the same owner-or-editor rule the REST graph save
   *    uses, so the same action has the same authority whichever transport asked for it. A stranger
   *    still receives the identical non-enumerating `404`; an editor grant means edit over both.
   * 2. **Hand the operation to the session**, which applies it, re-canonicalises it, persists it
   *    through its ordered queue, and pushes the result to every open editor — in that order, and
   *    serialized against every other writer of the same diagram. None of that happens here any
   *    more, and that is what closes the lost-update race: a use case that read the graph, changed
   *    it and wrote it back could not see a concurrent writer doing the same.
   *
   * The operation travels as a **value** rather than a closure, which the Durable Object RPC
   * boundary requires: arguments are structured-cloned, and a function is not cloneable. See
   * `../domain/graph-operations.ts`.
   *
   * @param actorEmail Verified Cloudflare Access identity making the change.
   * @param id Unvalidated diagram id supplied by the caller.
   * @param operation The single operation to apply.
   * @returns The diagram as it now stands, carrying the new graph and `updatedAt` so a calling
   *   agent can see the result of its own change without a second read. The graph is the one that
   *   was **persisted**, which under a concurrent edit may already include somebody else's change —
   *   reporting the caller's own intention instead would describe a graph nobody can read back.
   * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is malformed, unknown,
   *   inaccessible to the actor, or deleted while the write was in flight, and when the operation
   *   targets a node or edge that does not exist; `badRequest()` (400) when it supplies an id
   *   already in use; `unprocessableContent()` (422) when the result fails canonical validation;
   *   and `internalServerError()` (500) when the write itself failed.
   * @throws {Error} When the repository cannot read the row, or the session cannot be reached at
   *   all — a transport failure, as distinct from a refusal, which arrives as a value and is
   *   rethrown above as the problem document it describes.
   */
  async applyGraphOperation(
    actorEmail: string,
    id: string,
    operation: GraphOperation
  ): Promise<Diagram> {
    // The same widened rule as the REST whole-graph save. Editing the graph is the same action
    // whichever transport described it, so an agent acting for a collaborator may do exactly what
    // that collaborator's browser may do — and no more.
    const { diagram } = await this.access.requireAccessible(actorEmail, id);

    const { graphData, updatedAt } = requireApplied(
      await this.sessions.applyOperation(diagram.id, operation, actorEmail)
    );

    return { ...diagram, graphData, updatedAt };
  }

  /**
   * Opens an authorized live connection to a diagram the actor owns or collaborates on.
   *
   * The third widened method. Authorization happens here, before the upgrade is forwarded, and that
   * is the whole of it — the session itself never re-derives the decision, because it has no route
   * of its own and can only be reached through a Worker that already took it. Putting the check in
   * the use case rather than in the route is what makes it the same check `get` and `saveGraph`
   * perform: a connection is a way of reading and editing a diagram, so it answers the identical
   * non-enumerating `404`.
   *
   * @param actorEmail Verified Cloudflare Access identity opening the connection.
   * @param id Unvalidated diagram id from the request path.
   * @param request The viewer's own upgrade request, forwarded so the Hibernation API can complete
   *   the protocol switch against it. Whatever identity headers it carries are discarded by the
   *   adapter before the session sees it.
   * @returns The `101 Switching Protocols` response, to be returned to the browser unchanged.
   * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is malformed, unknown, or the
   *   actor neither owns it nor holds a grant on it.
   * @throws {Error} When a repository cannot read its rows or the session cannot accept the
   *   connection.
   */
  async connectLiveSession(actorEmail: string, id: string, request: Request): Promise<Response> {
    const { diagram } = await this.access.requireAccessible(actorEmail, id);

    return this.sessions.connect(diagram.id, request, actorEmail);
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
   * The narrow rule, and the only place the ownership comparison itself is written. Every method
   * above that must stay owner-only routes through it: rename, delete, duplicate, and — through
   * `./share-service.ts` and `./collaborator-service.ts` reaching their own equivalents — the share
   * link and the collaborator list.
   *
   * {@link DiagramService.applyGraphOperation} deliberately still uses it. An MCP tool acts with the
   * authority of the identity that configured it, and widening agent writes to every diagram that
   * identity collaborates on is a decision about agent scope rather than a consequence of adding
   * collaborators; the authorization-parity sub-phase takes it explicitly.
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
