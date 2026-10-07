import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import { validateDiagramId } from '../domain/diagram-validation.ts';
import type { PublicDiagram } from '../domain/diagram.ts';
import { validateDirectoryPage } from '../domain/user-validation.ts';
import type { AdminUserDirectoryPage } from '../domain/user.ts';
import type { DiagramService } from './diagram-service.ts';
import type { UserRepository } from './ports/user-repository.ts';

/**
 * Operator use cases: the user directory, and moderation of any identity's diagram.
 *
 * Every other service in this Worker scopes its work to one actor's own data. This one deliberately
 * does the opposite, which is why it is a service of its own rather than extra methods bolted onto
 * the ones beside it: a reader looking for "what can cross the ownership boundary?" should find one
 * file rather than a scattering of specially-marked methods.
 *
 * **It takes no actor, and that is deliberate.** There is exactly one administrator, named by the
 * operator through the `ADMIN_EMAIL` Worker variable, and `../middleware/require-admin.ts` compares
 * the verified Access identity to it before any route on the administrative router runs.
 * Re-deriving that comparison here would be a second spelling of a rule whose entire value is
 * having one — and, worse, a second spelling that a later refactor could leave disagreeing with the
 * first. What this service's signatures say instead is sharper: _by the time you are calling me,
 * that decision has been taken._.
 *
 * The moderation delete is routed through {@link DiagramService} rather than reaching the diagram
 * repository directly. A moderated diagram has to leave exactly the state an owner's own delete
 * leaves — including the cascade that stops every share link to it resolving — and the surest way
 * to guarantee that is for there to be one delete rather than two that must be kept in step.
 */
export class AdminService {
  /**
   * @param users Authorization-neutral persistence port backing the directory read.
   * @param diagrams Diagram use cases. Depended on rather than the diagram repository, so the
   *   moderation delete reuses the owner delete's cascade instead of reimplementing it.
   */
  constructor(
    private readonly users: UserRepository,
    private readonly diagrams: DiagramService
  ) {}

  /**
   * Lists one page of the user directory, most recently active identity first, each row annotated
   * with how many diagrams it currently owns.
   *
   * Reports a count per identity rather than the diagrams themselves, and that scope is the design
   * rather than an unfinished feature: the directory answers "who has used this deployment, and how
   * much", which needs no access to anybody's content. An administrator who needs to look at a
   * specific diagram uses {@link AdminService.getDiagram}, which is a separate, separately-logged
   * act against a named id.
   *
   * @param query Raw `limit`/`offset` query-string values from the request.
   * @returns The requested page, plus the directory's total row count so the caller can tell
   *   whether another page exists.
   * @throws {ProblemDetailsError} `unprocessableContent()` (422) when `limit` or `offset` is
   *   present but malformed, or when `limit` is outside the accepted range.
   * @throws {Error} When the repository cannot read the rows.
   */
  async listUsers(query: { limit?: string; offset?: string }): Promise<AdminUserDirectoryPage> {
    const page = validateDirectoryPage(query);

    // The window is echoed back from the *validated* value, not the raw query string. Both
    // parameters are optional, so a client that sent neither would otherwise be unable to ask for
    // the next page without hard-coding this service's defaults.
    return { ...(await this.users.listWithDiagramCounts(page)), ...page };
  }

  /**
   * Reads any identity's diagram for moderation review, without disclosing who owns it.
   *
   * Returns the same owner-blind projection the anonymous share viewer receives, and that choice is
   * what keeps the administrative surface from being a second, broader way to read other people's
   * data. An administrator deciding whether to delete a diagram needs to see what it _contains_;
   * they do not need to be told whose it is, and the directory above already answers "who owns how
   * many" without naming a single diagram. The two surfaces therefore stay genuinely separate
   * rather than composing into a per-user content browser.
   *
   * @param id Unvalidated diagram id from the request path.
   * @returns The diagram's id, title, description and current graph.
   * @throws {ProblemDetailsError} `notFound()` (404) when the id is malformed or no diagram has it.
   *   Unlike the owner-scoped routes, this `404` means only "there is no such diagram" — an
   *   administrator has nothing to be refused, so the status is not doing double duty here.
   * @throws {Error} When the repository cannot read the row.
   */
  async getDiagram(id: string): Promise<PublicDiagram> {
    const diagram = await this.diagrams.getPublicFields(validateDiagramId(id));

    if (diagram === null) {
      throw notFound({ detail: 'Diagram not found.' });
    }
    return diagram;
  }

  /**
   * Deletes any identity's diagram, cascading the revocation of every share link to it.
   *
   * @param id Unvalidated diagram id from the request path.
   * @returns A promise fulfilled once the diagram no longer exists and no link to it resolves.
   * @throws {ProblemDetailsError} `notFound()` (404) when the id is malformed or no diagram has
   * it.
   * @throws {Error} When the repository cannot delete or revoke a row.
   */
  async removeDiagram(id: string): Promise<void> {
    await this.diagrams.removeWithoutOwnerCheck(id);
  }
}
