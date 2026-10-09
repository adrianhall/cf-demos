/**
 * @file The collaboration domain's data shapes. Pure types with no binding, fetch or transport
 *   dependency, matching `./diagram.ts` and `./share.ts`, so the HTTP API and any later transport
 *   describe one collaboration model rather than two near-identical ones. One distinction shapes
 *   everything here and is worth stating once: a **collaborator** is a verified Cloudflare Access
 *   identity granted edit access to one diagram, whereas a **share** (`./share.ts`) is an
 *   anonymous, read-only bearer link. They answer different questions, so they have different
 *   tables, different routes and different types rather than one type with a mode flag.
 */

import type { Diagram } from './diagram.ts';

/**
 * What a given identity may do with a given diagram.
 *
 * Deliberately only two values. There is no authenticated read-only role: the anonymous share link
 * already answers "let somebody view this", and a third sharing concept would add a permission
 * matrix without adding a capability the demo lacks. A route that must stay owner-only therefore
 * compares against `'owner'` rather than consulting a capability table.
 */
export type DiagramRole = 'owner' | 'editor';

/**
 * A diagram together with the role the asking identity holds on it.
 *
 * Returned as one value rather than as two queries so a handler can authorize an owner-only action
 * without a second read: the diagram it already loaded carries the answer. See
 * {@link CollaboratorService.requireAccessible}.
 */
export interface AccessibleDiagram {
  /**
   * The diagram itself, exactly as an owner-scoped read would return it.
   */
  diagram: Diagram;
  /**
   * Whether the asking identity owns this diagram or was granted edit access to it.
   */
  role: DiagramRole;
}

/**
 * One collaborator row, as the application tier sees it.
 *
 * `addedBy` is carried up from storage even though no route returns it today. It is the grant's
 * audit trail, and a type that dropped it would make the column unreachable from the tier that
 * would have to answer "who granted this" if anybody ever asked.
 */
export interface Collaborator {
  /**
   * Diagram the grant applies to.
   */
  diagramId: string;
  /**
   * Verified Cloudflare Access identity granted edit access.
   */
  collaboratorEmail: string;
  /**
   * Human-readable directory name, or `null` when the identity provider supplied none.
   *
   * Always `null` in this demo today — the verified Access identity carries no name claim — and
   * retained anyway for schema fidelity and forward compatibility. A deployment that later records
   * names can show them without changing this API's shape.
   */
  displayName: string | null;
  /**
   * Owner's email at the moment the grant was made. Audit trail only.
   */
  addedBy: string;
  /**
   * ISO-8601 timestamp the grant was recorded.
   */
  addedAt: string;
}

/**
 * A diagram somebody else owns, which the asking identity may edit.
 *
 * The dashboard's "Shared with me" section renders these. `ownerEmail` is already part of
 * {@link Diagram}, so this type adds nothing to the shape — it exists as a named alias because the
 * list it describes is semantically the inverse of the owner's own list, and reading
 * `SharedWithMeDiagram[]` at a call site says which of the two a reader is looking at.
 */
export type SharedWithMeDiagram = Diagram;
