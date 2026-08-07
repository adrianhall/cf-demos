import type { BlueprintId } from "../../graph/blueprints";

/** A diagram's D1 directory row, independent of its live Durable Object document. */
export interface Diagram {
  /** Stable UUID, also used as the `DiagramRoom` name. */
  id: string;
  /** Verified Cloudflare Access email of the diagram's owner. */
  ownerEmail: string;
  /** User-editable title. */
  title: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of the most recent title change or accepted document edit. */
  updatedAt: string;
}

/** Validated `POST /api/diagrams` request body. */
export interface CreateDiagramInput {
  /** User-supplied diagram title. */
  title: string;
  /** Starter blueprint applied immediately after creation. Defaults to `"blank"`. */
  blueprintId?: BlueprintId;
}

/** Validated `PATCH /api/diagrams/:id` request body. Phase 2 supports renaming only. */
export interface UpdateDiagramInput {
  /** Replacement title. */
  title: string;
}

/** One `diagram_members` row, as returned by `GET /api/diagrams/:id/members`. */
export interface DiagramMember {
  /** Verified Cloudflare Access email of the member. */
  email: string;
  /** `"owner"` — exactly one per diagram, set at creation — or `"editor"`. */
  role: "owner" | "editor";
}
