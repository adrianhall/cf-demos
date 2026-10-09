import type { Collaborator, SharedWithMeDiagram } from '../../domain/collaborator.ts';

/**
 * Persistence port for diagram collaborators.
 *
 * Like {@link DiagramRepository} and {@link ShareRepository}, every method here is
 * **authorization-neutral**, and for the same reason: an "is this caller allowed?" decision taken
 * in storage would have to be re-taken by every transport that reaches it. `remove` deletes a row
 * for anybody who asks; whether the asker may ask is decided in `../collaborator-service.ts`, above
 * this line, where one rule serves every caller.
 *
 * {@link CollaboratorRepository.isCollaborator} is the nearest thing to an exception and is still a
 * query rather than a decision: "does a grant row exist for this pair" is a fact about storage.
 * What that fact _means_ — that the identity may read and edit the diagram, but not rename, delete
 * or re-share it — is decided above.
 *
 * The source design (`09C-COLLABORATIVE-EDITING.md`) put validation, the ownership rule and SQL in
 * one `CollaboratorRepository` class. That shape is deliberately not reproduced here: it collapses
 * the three tiers this port keeps apart, and the rule most worth keeping above storage is exactly
 * the one a collapsed class puts out of reach of a second transport.
 */
export interface CollaboratorRepository {
  /**
   * Records a collaborator grant, or returns the grant that already existed.
   *
   * Idempotent by contract rather than by the caller checking first. An owner double-clicking, or
   * two of their tabs, must not see an error for an outcome that is already true — and a
   * read-then-write in the caller would race itself between the read and the write. The adapter
   * resolves it in one statement using the composite primary key.
   *
   * @param diagramId Diagram the grant applies to.
   * @param collaboratorEmail Identity being granted edit access. The service has already checked
   *   that it exists in the user directory and is not the owner; this port re-checks neither.
   * @param addedBy Owner's email, recorded as the grant's audit trail.
   * @param addedAt ISO-8601 timestamp to record. Passed in rather than read from a clock inside the
   *   adapter, so a test asserts the stored value instead of tolerating whatever "now" was.
   * @returns The stored grant: the newly inserted row, or the pre-existing one with its original
   *   `addedBy` and `addedAt` intact. Keeping the original values is deliberate — re-adding
   *   somebody is not a new grant, and rewriting the audit trail would erase when access was
   *   actually given.
   * @throws {Error} When the underlying store rejects the write.
   */
  add(
    diagramId: string,
    collaboratorEmail: string,
    addedBy: string,
    addedAt: string
  ): Promise<Collaborator>;

  /**
   * Deletes one collaborator grant.
   *
   * @param diagramId Diagram the grant applies to.
   * @param collaboratorEmail Identity whose access is being removed.
   * @returns `true` when a row was deleted, and `false` when no grant matched — which the service
   *   reports as `404`, so a repeated removal is refused rather than quietly reported as success.
   * @throws {Error} When the underlying store rejects the delete.
   */
  remove(diagramId: string, collaboratorEmail: string): Promise<boolean>;

  /**
   * Lists every collaborator on one diagram, earliest grant first.
   *
   * Each grant is joined to the user directory for `displayName`. That value is always `null` in
   * this demo today — Access supplies no name claim — and retained for schema fidelity and forward
   * compatibility rather than because the current UI can show one.
   *
   * Ordered by grant time rather than alphabetically, because the list is a record of who was given
   * access and when. Sorting by address would reorder the list as people come and go, for no
   * reader's benefit.
   *
   * @param diagramId Diagram whose collaborators to read.
   * @returns That diagram's grants, oldest first. Empty when it has none, which is an answer rather
   *   than an error.
   * @throws {Error} When the underlying store rejects the read.
   */
  listForDiagram(diagramId: string): Promise<Collaborator[]>;

  /**
   * Lists the diagrams one identity may edit but does not own, most recently updated first.
   *
   * This is the one method here that reads the `diagrams` table, and it is deliberate: "the
   * diagrams I collaborate on" is inherently a join from a grant to the row it points at, and the
   * alternative — return ids, then read each diagram separately — is N round trips to answer one
   * question. Each row carries its owner's email, which is what lets the dashboard say who shared
   * it.
   *
   * Deliberately a separate query from {@link DiagramRepository.listByOwner} rather than a scope
   * parameter on it. That owner-scoped list is the documented contract the MCP `list_diagrams` tool
   * relies on, and widening its shape would be a breaking change to that tool for no benefit here.
   *
   * @param collaboratorEmail Identity whose grants to resolve into diagrams.
   * @returns The diagrams that identity collaborates on, newest activity first. Never includes one
   *   they own, because an owner is never also a collaborator — see
   *   `../../domain/collaborator-validation.ts`'s `rejectSelfCollaboration`.
   * @throws {Error} When the underlying store rejects the read.
   */
  listSharedWith(collaboratorEmail: string): Promise<SharedWithMeDiagram[]>;

  /**
   * Reports whether one identity holds a grant on one diagram.
   *
   * Says nothing about ownership, and must not: the owner holds no grant row, so a service that
   * read this alone would refuse the owner their own diagram. The two halves are combined in
   * `../collaborator-service.ts`, which is the one place the complete access rule is written.
   *
   * @param diagramId Diagram to check.
   * @param email Identity to check.
   * @returns `true` when a grant row exists for that pair, and `false` otherwise — including when
   *   the diagram does not exist at all, since a grant cannot name a missing diagram.
   * @throws {Error} When the underlying store rejects the read.
   */
  isCollaborator(diagramId: string, email: string): Promise<boolean>;
}
