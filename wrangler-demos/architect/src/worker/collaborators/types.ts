/**
 * One row of the `diagram_collaborators` table (docs/09C-COLLABORATIVE-EDITING.md's Collaborator
 * Model Data Model): a specific, already-known Cloudflare Access identity granted full edit
 * access to a diagram it does not own. Distinct from `../shares/types.ts`'s `SharedDiagram` --
 * that type backs anonymous, read-only, unauthenticated access; this one backs authenticated,
 * full-edit access limited to identities the owner explicitly added.
 */
export interface Collaborator {
  /** Diagram id the collaborator was granted access to. */
  diagramId: string;
  /** Verified Cloudflare Access identity email granted collaborator access. Must already exist
   * in the `users` directory (`../users/repository.ts`) at the moment it is added. */
  email: string;
  /** Display name for `email`, joined from `users.display_name`. Always `null` in this demo --
   * `users` never populates it (`../users/repository.ts`'s `upsert()` never writes anything but
   * `NULL` for it) -- kept purely for schema fidelity and forward compatibility. */
  displayName: string | null;
  /** Email of the diagram's owner at the moment this collaborator was added. An audit trail
   * only; no route ever reads it back. */
  addedBy: string;
  /** ISO-8601 timestamp this collaborator was added. */
  addedAt: string;
}
