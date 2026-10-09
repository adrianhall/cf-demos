import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import {
  rejectSelfCollaboration,
  validateAddCollaboratorInput,
  validateCollaboratorEmail
} from '../domain/collaborator-validation.ts';
import type {
  AccessibleDiagram,
  Collaborator,
  SharedWithMeDiagram
} from '../domain/collaborator.ts';
import { validateDiagramId } from '../domain/diagram-validation.ts';
import type { CollaboratorRepository } from './ports/collaborator-repository.ts';
import type { DiagramRepository } from './ports/diagram-repository.ts';
import type { UserRepository } from './ports/user-repository.ts';

/**
 * Detail used by every refusal that must not disclose whether a diagram exists.
 *
 * The same string {@link DiagramService} uses, and shared for the same reason the statuses are: "no
 * such diagram", "somebody else's diagram" and "that is not even an id" are already reported with
 * one status, and a different sentence for each would make the body the oracle the status code
 * deliberately is not.
 */
const DIAGRAM_NOT_FOUND = 'Diagram not found.';

/**
 * The directory read this service needs, and no more.
 *
 * Narrowed with `Pick` rather than taking the whole {@link UserRepository}, so the claim made
 * elsewhere — the directory is written as a side effect of authentication and read only by the
 * administrative view — stays true by construction. This service physically cannot reach the
 * paginated directory listing; `./admin-service.ts` holds that, behind the administrator check.
 */
type UserDirectoryLookup = Pick<UserRepository, 'exists'>;

/**
 * The diagram read this service needs, and no more.
 *
 * Narrowed for the same reason as {@link UserDirectoryLookup}: granting and revoking edit access
 * must never be a route to writing or deleting a diagram, and a service holding only `find` cannot
 * become one however it is later edited.
 */
type DiagramLookup = Pick<DiagramRepository, 'find'>;

/**
 * Use cases for authenticated edit collaboration — the tier between the HTTP API and persistence.
 *
 * It answers two different questions, and keeping them in one service is what stops them drifting
 * apart:
 *
 * - **Who may reach this diagram at all?** {@link CollaboratorService.requireAccessible} resolves a
 *   diagram together with the asking identity's role, so a handler can admit an editor to a read or
 *   a graph save while still gating rename, delete and sharing on `'owner'`. It is the only place
 *   the widened rule is written.
 * - **Who may change that list?** Adding is owner-only. Removing is allowed to the owner, or to a
 *   collaborator removing themselves — and to nobody else. Every other combination is refused
 *   before a row is touched.
 *
 * Two postures are deliberately not symmetrical, and the asymmetry is the security decision worth
 * noticing. A refusal that would disclose whether a diagram exists is the uniform `404` every other
 * diagram route gives. A refusal that discloses nothing the caller did not already supply — an
 * owner naming their own address, or an identity that has never signed in — says what is actually
 * wrong, because a `404` there would send a person looking for a diagram that is sitting in front
 * of them.
 *
 * The service depends only on ports, never on D1, so the rules are written once above storage
 * rather than repeated in every query. The source design's single `CollaboratorRepository` put
 * these same rules inside the adapter; see `./ports/collaborator-repository.ts` for why that shape
 * is not reproduced.
 */
export class CollaboratorService {
  /**
   * @param collaborators Authorization-neutral persistence port for grants.
   * @param diagrams Diagram lookup, narrowed to the owner-blind read; see {@link DiagramLookup}.
   *   This service compares the owner itself rather than asking storage to filter, which is the
   *   same division {@link DiagramService} uses and the reason both can state the rule once.
   * @param users Directory lookup, narrowed to the existence check; see
   *   {@link UserDirectoryLookup}. It backs the "that person must sign in once first" rule and
   *   nothing else.
   */
  constructor(
    private readonly collaborators: CollaboratorRepository,
    private readonly diagrams: DiagramLookup,
    private readonly users: UserDirectoryLookup
  ) {}

  /**
   * Resolves a diagram the actor may read and edit, with the role they hold on it.
   *
   * The widened sibling of {@link DiagramService}'s owner-only rule, and deliberately an addition
   * rather than a replacement: every genuinely owner-only use case — rename, delete, share-link
   * management, collaborator management — keeps the narrow rule, and only the three surfaces a
   * collaborator must reach use this one. A reader can therefore tell which rule a route is held to
   * by which method it calls.
   *
   * The returned `role` is what lets a handler gate an owner-only action without a second query.
   * `requireOwner` below is the sanctioned way to use it, so the comparison is written once.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @returns The diagram and the actor's role on it.
   * @throws {ProblemDetailsError} `notFound()` (404) when the id is malformed, when no diagram has
   *   it, or when the actor neither owns it nor holds a grant on it. All three are reported
   *   identically, with the same detail, so a caller cannot tell them apart — a stranger learns
   *   exactly as much from probing a real id as from probing a made-up one.
   * @throws {Error} When a repository cannot read its rows.
   */
  async requireAccessible(actorEmail: string, id: string): Promise<AccessibleDiagram> {
    const diagram = await this.diagrams.find(validateDiagramId(id));

    if (diagram === null) {
      throw notFound({ detail: DIAGRAM_NOT_FOUND });
    }

    if (diagram.ownerEmail === actorEmail) {
      return { diagram, role: 'owner' };
    }

    // Checked only after ownership, so an owner's own read never costs a second query. The grant
    // lookup is the widened half of the rule and the only reason a non-owner ever gets past here.
    if (await this.collaborators.isCollaborator(diagram.id, actorEmail)) {
      return { diagram, role: 'editor' };
    }

    throw notFound({ detail: DIAGRAM_NOT_FOUND });
  }

  /**
   * Resolves a diagram the actor owns, refusing a collaborator with the same uniform `404`.
   *
   * Built on {@link CollaboratorService.requireAccessible} rather than beside it, so there is one
   * lookup and one place the `'owner'` comparison is written. A collaborator is refused with the
   * same `404` a stranger receives, not a `403`: they can see the diagram, so a distinct status
   * would disclose nothing — but giving the two refusals one shape means no route can accidentally
   * answer `403` and turn a status code into a signal somewhere else.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @returns The diagram, which the actor owns.
   * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is malformed, absent, or the
   *   actor is anything other than its owner — including a collaborator on it.
   * @throws {Error} When a repository cannot read its rows.
   */
  async requireOwner(actorEmail: string, id: string): Promise<AccessibleDiagram['diagram']> {
    const { diagram, role } = await this.requireAccessible(actorEmail, id);

    if (role !== 'owner') {
      throw notFound({ detail: DIAGRAM_NOT_FOUND });
    }
    return diagram;
  }

  /**
   * Lists a diagram's collaborators, for the owner or any of those collaborators.
   *
   * A collaborator may read the list, not only the owner: somebody editing a diagram alongside
   * other people has a legitimate reason to know who those people are, and withholding it would
   * make a shared document feel like a private one that happens to change by itself.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @returns The diagram's grants, oldest first. Empty for a diagram nobody has been added to.
   * @throws {ProblemDetailsError} `notFound()` (404) when the diagram is malformed, absent, or the
   *   actor neither owns it nor collaborates on it.
   * @throws {Error} When a repository cannot read its rows.
   */
  async list(actorEmail: string, id: string): Promise<Collaborator[]> {
    const { diagram } = await this.requireAccessible(actorEmail, id);

    return this.collaborators.listForDiagram(diagram.id);
  }

  /**
   * Grants a previously signed-in identity edit access to one of the actor's own diagrams.
   *
   * The sequence is fixed and each step refuses for a different reason:
   *
   * 1. **Validate the email** before anything is read, so a malformed body cannot be used to probe
   *    which diagram ids exist.
   * 2. **Resolve the owned diagram**, which refuses a collaborator trying to add somebody else with
   *    the same `404` a stranger gets. Managing the list is an owner's capability only.
   * 3. **Refuse the owner adding themselves**, with `400` — see `rejectSelfCollaboration`.
   * 4. **Require the target to exist in the directory**, with `404` and a message that says what to do
   *    about it. This is the step that keeps the demo free of an invitation system.
   * 5. **Record the grant**, idempotently.
   *
   * @param actorEmail Verified Cloudflare Access identity making the grant.
   * @param id Unvalidated diagram id from the request path.
   * @param body Unvalidated JSON body carrying the `email` to add.
   * @param now Clock used for the grant timestamp. Injected so a test asserts a known value;
   *   defaults to the real clock for production callers.
   * @returns The grant, whether it was created now or already existed. Re-adding an existing
   *   collaborator succeeds and returns the original row, so a client never has to special-case
   *   "already a collaborator" — the outcome it asked for is true either way.
   * @throws {ProblemDetailsError} `badRequest()` (400) when the body is not an object or names the
   *   owner's own address; `unprocessableContent()` (422) when the email is malformed; and
   *   `notFound()` (404) when the diagram is malformed, absent or not the actor's, **or** when the
   *   named identity has never signed in. The last case carries a deliberately different,
   *   actionable detail: it discloses nothing about this deployment's user list that the caller did
   *   not already supply, and telling them nothing would leave them retyping an address that is
   *   spelled correctly.
   * @throws {Error} When a repository cannot read or write its rows.
   */
  async add(
    actorEmail: string,
    id: string,
    body: unknown,
    now: () => Date = () => new Date()
  ): Promise<Collaborator> {
    const collaboratorEmail = validateAddCollaboratorInput(body);
    const diagram = await this.requireOwner(actorEmail, id);

    rejectSelfCollaboration(diagram.ownerEmail, collaboratorEmail);

    if (!(await this.users.exists(collaboratorEmail))) {
      throw notFound({
        detail:
          `${collaboratorEmail} has not signed in to Architect yet. Ask them to open it once, `
          + 'then add them again.'
      });
    }

    return this.collaborators.add(
      diagram.id,
      collaboratorEmail,
      diagram.ownerEmail,
      now().toISOString()
    );
  }

  /**
   * Removes one collaborator, for the diagram's owner or for that collaborator themselves.
   *
   * Two identities may perform this and no others: the owner removing anybody, and a collaborator
   * removing their own grant — the "Leave diagram" path. A collaborator removing a _different_
   * collaborator is refused, and refused **before** any row is touched, so the attempt cannot
   * succeed partially or be inferred from a timing difference between a grant that exists and one
   * that does not.
   *
   * The refusal for that case is the same `404` a stranger gets rather than a `403`. A collaborator
   * can already see the diagram and the list, so the status discloses nothing either way; giving
   * every refusal on a diagram route one shape is what keeps a `403` from appearing somewhere it
   * would be a signal.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @param id Unvalidated diagram id from the request path.
   * @param targetEmail Unvalidated collaborator email from the request path.
   * @returns A promise fulfilled once the grant no longer exists.
   * @throws {ProblemDetailsError} `unprocessableContent()` (422) when the email is malformed;
   *   `notFound()` (404) when the diagram is malformed, absent or unreachable by the actor, when
   *   the actor is a collaborator naming somebody other than themselves, or when no such grant
   *   exists — the last so a repeated removal is refused rather than quietly reported as success.
   * @throws {Error} When a repository cannot read or write its rows.
   */
  async remove(actorEmail: string, id: string, targetEmail: string): Promise<void> {
    const collaboratorEmail = validateCollaboratorEmail(targetEmail);
    const { diagram, role } = await this.requireAccessible(actorEmail, id);

    // The complete rule, in one expression, evaluated before D1 is touched: an owner may remove
    // anybody, and anybody else may remove only themselves.
    const permitted = role === 'owner' || collaboratorEmail === actorEmail;
    if (!permitted) {
      throw notFound({ detail: DIAGRAM_NOT_FOUND });
    }

    if (!(await this.collaborators.remove(diagram.id, collaboratorEmail))) {
      throw notFound({ detail: 'Collaborator not found.' });
    }
  }

  /**
   * Lists the diagrams the actor may edit but does not own.
   *
   * Deliberately its own use case rather than a mode of the owner's list. The two sets never
   * overlap — an owner cannot be added as a collaborator to their own diagram — so a caller showing
   * both is showing two disjoint sections rather than one list filtered twice.
   *
   * @param actorEmail Verified Cloudflare Access identity making the request.
   * @returns The diagrams shared with that identity, newest activity first, each carrying its
   *   owner's email so the dashboard can say who shared it. Empty when none have been, which is a
   *   successful answer rather than an error.
   * @throws {Error} When the repository cannot read the rows.
   */
  async listSharedWithMe(actorEmail: string): Promise<SharedWithMeDiagram[]> {
    return this.collaborators.listSharedWith(actorEmail);
  }
}
