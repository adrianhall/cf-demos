import type { GraphDocument } from "./types";

/** Stable identifier for one starter blueprint offered at diagram-creation time. */
export type BlueprintId = "blank" | "static-site" | "api-storage";

/** One starter blueprint: a label shown at diagram-creation time and its seed document. */
export interface Blueprint {
  /** Stable identifier sent as `POST /api/diagrams`'s optional `blueprintId`. */
  id: BlueprintId;
  /** Creation-dialog display name. */
  label: string;
  /** Short description of what the blueprint demonstrates. */
  description: string;
  /** Seed document applied via the `replace_document` operation right after creation. */
  document: GraphDocument;
}

const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

/** An empty document, used both as the blank blueprint and `DiagramRoom`'s own initial state. */
export const emptyGraphDocument: GraphDocument = {
  version: 1,
  nodes: [],
  edges: [],
  viewport: DEFAULT_VIEWPORT,
};

/**
 * A few small, real starter blueprints — not a copy of every prior-art template — matching
 * Phase 2's "keep the catalog modest" guidance.
 */
export const blueprints: readonly Blueprint[] = [
  {
    id: "blank",
    label: "Blank",
    description: "Start from an empty canvas.",
    document: emptyGraphDocument,
  },
  {
    id: "static-site",
    label: "Static site",
    description: "A browser served directly by Workers static assets.",
    document: {
      version: 1,
      nodes: [
        {
          id: "browser",
          type: "actor",
          position: { x: 40, y: 160 },
          data: { kind: "external-actor", label: "Visitor browser" },
        },
        {
          id: "workers",
          type: "product",
          position: { x: 320, y: 160 },
          data: {
            productId: "workers",
            label: "Workers",
            description: "Serves static assets and the SPA fallback",
          },
        },
      ],
      edges: [
        {
          id: "request",
          source: "browser",
          target: "workers",
          type: "request",
          data: { relationship: "request", label: "HTTPS request" },
        },
      ],
      viewport: DEFAULT_VIEWPORT,
    },
  },
  {
    id: "api-storage",
    label: "API + storage",
    description: "A Workers API backed by D1 and R2.",
    document: {
      version: 1,
      nodes: [
        {
          id: "browser",
          type: "actor",
          position: { x: 20, y: 200 },
          data: { kind: "external-actor", label: "Client application" },
        },
        {
          id: "workers",
          type: "product",
          position: { x: 300, y: 200 },
          data: {
            productId: "workers",
            label: "Workers API",
            description: "Handles requests and coordinates storage",
          },
        },
        {
          id: "d1",
          type: "product",
          position: { x: 580, y: 80 },
          data: {
            productId: "d1",
            label: "D1",
            description: "Relational records",
          },
        },
        {
          id: "r2",
          type: "product",
          position: { x: 580, y: 320 },
          data: {
            productId: "r2",
            label: "R2",
            description: "Uploaded object storage",
          },
        },
      ],
      edges: [
        {
          id: "request",
          source: "browser",
          target: "workers",
          type: "request",
          data: { relationship: "request", label: "HTTPS request" },
        },
        {
          id: "read-write",
          source: "workers",
          target: "d1",
          type: "request",
          data: { relationship: "request", label: "read / write" },
        },
        {
          id: "store-object",
          source: "workers",
          target: "r2",
          type: "event",
          data: { relationship: "event", label: "store object" },
        },
      ],
      viewport: DEFAULT_VIEWPORT,
    },
  },
];

/**
 * Look up a starter blueprint by its stable identifier.
 *
 * @param blueprintId Candidate blueprint identifier, or `undefined` to select `"blank"`.
 * @returns The matching blueprint.
 * @throws {Error} When `blueprintId` does not match a known blueprint.
 */
export function getBlueprint(blueprintId: BlueprintId | undefined): Blueprint {
  const id = blueprintId ?? "blank";
  const blueprint = blueprints.find((candidate) => candidate.id === id);
  if (!blueprint) {
    throw new Error(`Unknown blueprint: ${id}`);
  }
  return blueprint;
}

/**
 * Check whether an untrusted string is a known blueprint identifier.
 *
 * @param value Candidate string from a request body.
 * @returns Whether `value` narrows to {@link BlueprintId}.
 */
export function isBlueprintId(value: string): value is BlueprintId {
  return blueprints.some((blueprint) => blueprint.id === value);
}
