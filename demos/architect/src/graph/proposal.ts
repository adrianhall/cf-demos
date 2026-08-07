import { catalog, catalogProductIds } from "./catalog";
import { GraphValidationError, validateGraphDocument } from "./validation";
import type { GraphDocument, ProductId } from "./types";

/** Maximum number of nodes an AI-generated proposal may contain, matching Spike 09's 2-8 bound. */
const MIN_PROPOSAL_NODES = 2;
const MAX_PROPOSAL_NODES = 8;
/** Maximum number of edges an AI-generated proposal may contain, matching Spike 09's 0-10 bound. */
const MAX_PROPOSAL_EDGES = 10;

/** Horizontal spacing (graph-space units) between grid-laid-out proposal nodes. */
const LAYOUT_COLUMN_WIDTH = 240;
/** Vertical spacing (graph-space units) between grid-laid-out proposal rows. */
const LAYOUT_ROW_HEIGHT = 160;
/** Number of nodes placed per row before wrapping, keeping a small proposal roughly square. */
const LAYOUT_COLUMNS = 4;

/**
 * One node in an AI-generated architecture proposal, before layout.
 *
 * Deliberately narrower than {@link import("./types").ArchitectureNode}: the model never
 * proposes a canvas position (that is assigned deterministically by
 * {@link architectureProposalToGraphDocument}), and `description` is optional because a short
 * proposal may reasonably omit it for an external actor.
 */
export interface ArchitectureProposalNode {
  /** Unique node id within the proposal, referenced by `ArchitectureProposalEdge.source/target`. */
  id: string;
  /** Discriminates a curated Cloudflare product node from an external-actor node. */
  type: "product" | "actor";
  /** Required when `type` is `"product"`; must be a curated catalog identifier. */
  productId?: ProductId;
  /** Display label. */
  label: string;
  /** Optional short explanation of this node's role. */
  description?: string;
}

/** One typed, labeled connection in an AI-generated architecture proposal. */
export interface ArchitectureProposalEdge {
  /** Unique edge id within the proposal. */
  id: string;
  /** Source node id — must reference a node in the same proposal. */
  source: string;
  /** Target node id — must reference a node in the same proposal, distinct from `source`. */
  target: string;
  /** Discriminates the two supported semantic relationships. */
  type: "request" | "event";
  /** User-visible description of the connection. */
  label: string;
}

/**
 * The raw shape Workers AI is asked to produce via `response_format`'s `json_schema` — see
 * {@link architectureProposalJsonSchema} — and the shape {@link validateArchitectureProposal}
 * accepts.
 */
export interface ArchitectureProposal {
  /** Short, human-readable title for the proposed architecture. */
  title: string;
  /** 2-8 proposed nodes. */
  nodes: ArchitectureProposalNode[];
  /** 0-10 proposed edges. */
  edges: ArchitectureProposalEdge[];
}

/**
 * The JSON Schema passed as Workers AI's `response_format.json_schema`
 * (`spikes/09-architect-ai-structured-output/REPORT.md`'s measured `response_format` adapter).
 *
 * Built from the same curated catalog (`./catalog.ts`) and relationship/type literals
 * (`./types.ts`) the rest of the graph contract uses, rather than a second, hand-maintained list
 * of product ids — see `docs/09-ARCHITECT.md`'s "reuse the shared architecture schema and
 * product catalog" instruction. `additionalProperties: false` and the 2-8/0-10 bounds match
 * Spike 09's ~679-byte measured schema shape exactly. JSON Mode does not guarantee schema
 * adherence (Spike 09's own finding), so this schema narrows the model's output but never
 * replaces {@link validateArchitectureProposal}'s independent validation.
 */
export const architectureProposalJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    nodes: {
      type: "array",
      minItems: MIN_PROPOSAL_NODES,
      maxItems: MAX_PROPOSAL_NODES,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["product", "actor"] },
          productId: {
            type: "string",
            enum: catalog.map((product) => product.id),
          },
          label: { type: "string" },
          description: { type: "string" },
        },
        required: ["id", "type", "label"],
        additionalProperties: false,
      },
    },
    edges: {
      type: "array",
      minItems: 0,
      maxItems: MAX_PROPOSAL_EDGES,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          source: { type: "string" },
          target: { type: "string" },
          type: { type: "string", enum: ["request", "event"] },
          label: { type: "string" },
        },
        required: ["id", "source", "target", "type", "label"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "nodes", "edges"],
  additionalProperties: false,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function fail(message: string): never {
  throw new GraphValidationError(message);
}

/**
 * Validate one candidate proposal node.
 *
 * Unknown catalog products fail clearly here — `docs/09-ARCHITECT.md`'s explicit instruction
 * that an AI proposal must never silently map an uncurated product onto a curated one (for
 * example Workers).
 *
 * @param value Candidate node value.
 * @returns The validated proposal node.
 * @throws {GraphValidationError} When the node's shape, type, or catalog membership is invalid.
 */
function validateProposalNode(value: unknown): ArchitectureProposalNode {
  if (!isRecord(value)) {
    fail("Every proposed node must be an object.");
  }
  const { id, type, productId, label, description } = value;
  if (!isNonEmptyString(id)) {
    fail("Every proposed node must have a non-empty string id.");
  }
  if (type !== "product" && type !== "actor") {
    fail(`Proposed node ${id} has an unsupported type.`);
  }
  if (!isNonEmptyString(label)) {
    fail(`Proposed node ${id} must have a non-empty label.`);
  }
  if (description !== undefined && typeof description !== "string") {
    fail(`Proposed node ${id} has a non-string description.`);
  }
  if (type === "product") {
    if (typeof productId !== "string" || !catalogProductIds.has(productId)) {
      fail(`Proposed node ${id} references an unknown catalog product.`);
    }
    return {
      id,
      type: "product",
      productId: productId as ProductId,
      label,
      description,
    };
  }
  return { id, type: "actor", label, description };
}

/**
 * Validate one candidate proposal edge's shape, independent of whether its endpoints exist —
 * endpoint existence is checked once, document-wide, after conversion by
 * {@link architectureProposalToGraphDocument} via the shared `validateGraphDocument`.
 *
 * @param value Candidate edge value.
 * @returns The validated proposal edge.
 * @throws {GraphValidationError} When the edge's shape or type is invalid.
 */
function validateProposalEdge(value: unknown): ArchitectureProposalEdge {
  if (!isRecord(value)) {
    fail("Every proposed edge must be an object.");
  }
  const { id, source, target, type, label } = value;
  if (!isNonEmptyString(id)) {
    fail("Every proposed edge must have a non-empty string id.");
  }
  if (!isNonEmptyString(source) || !isNonEmptyString(target)) {
    fail(`Proposed edge ${id} must have string source and target node ids.`);
  }
  if (type !== "request" && type !== "event") {
    fail(`Proposed edge ${id} has an unsupported type.`);
  }
  if (!isNonEmptyString(label)) {
    fail(`Proposed edge ${id} must have a non-empty label.`);
  }
  return { id, source, target, type, label };
}

/**
 * Validate an untrusted candidate value (the parsed JSON returned by
 * `ArchitectureGenerator.generate()`) against the AI proposal contract: shape, node/edge count
 * bounds, and curated catalog membership.
 *
 * This is deliberately narrower than {@link import("./validation").validateGraphDocument} — it
 * validates only what {@link architectureProposalJsonSchema} describes. Reference integrity
 * (dangling edge endpoints, duplicate ids, self-loops) is checked once, after conversion, by
 * `validateGraphDocument` inside {@link architectureProposalToGraphDocument} — the same function
 * every other graph mutation already goes through, rather than a second, forked integrity check.
 *
 * @param value Untrusted candidate value, typically `JSON.parse()`d model output.
 * @returns The validated proposal.
 * @throws {GraphValidationError} When any part of the contract is violated.
 */
export function validateArchitectureProposal(
  value: unknown,
): ArchitectureProposal {
  if (!isRecord(value)) {
    fail("A proposal must be an object.");
  }
  if (!isNonEmptyString(value.title)) {
    fail("A proposal must have a non-empty title.");
  }
  if (!Array.isArray(value.nodes)) {
    fail("A proposal's nodes must be an array.");
  }
  if (
    value.nodes.length < MIN_PROPOSAL_NODES ||
    value.nodes.length > MAX_PROPOSAL_NODES
  ) {
    fail(
      `A proposal must have between ${MIN_PROPOSAL_NODES} and ${MAX_PROPOSAL_NODES} nodes.`,
    );
  }
  if (!Array.isArray(value.edges)) {
    fail("A proposal's edges must be an array.");
  }
  if (value.edges.length > MAX_PROPOSAL_EDGES) {
    fail(`A proposal must have at most ${MAX_PROPOSAL_EDGES} edges.`);
  }

  const nodes = value.nodes.map(validateProposalNode);
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      fail(`Duplicate proposed node id: ${node.id}`);
    }
    nodeIds.add(node.id);
  }

  const edges = value.edges.map(validateProposalEdge);
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) {
      fail(`Duplicate proposed edge id: ${edge.id}`);
    }
    edgeIds.add(edge.id);
  }

  return { title: value.title, nodes, edges };
}

/**
 * Convert a validated {@link ArchitectureProposal} into a full, persistable
 * {@link GraphDocument}: assign each node a deterministic grid position (the model never
 * proposes one), default a product node's `description` to an empty string, then validate the
 * result with the exact same {@link import("./validation").validateGraphDocument} every other
 * graph mutation uses — catching a dangling edge endpoint, a self-loop, or a duplicate id that
 * {@link validateArchitectureProposal}'s shape-level check does not itself repeat.
 *
 * @param proposal A proposal already validated by {@link validateArchitectureProposal}.
 * @returns A `GraphDocument` ready to apply as a `replace_document` operation.
 * @throws {GraphValidationError} When the converted document fails graph-level validation (for
 * example, an edge referencing a node id that does not exist in this proposal).
 */
export function architectureProposalToGraphDocument(
  proposal: ArchitectureProposal,
): GraphDocument {
  const nodes = proposal.nodes.map((node, index) => ({
    id: node.id,
    type: node.type,
    position: {
      x: (index % LAYOUT_COLUMNS) * LAYOUT_COLUMN_WIDTH,
      y: Math.floor(index / LAYOUT_COLUMNS) * LAYOUT_ROW_HEIGHT,
    },
    data:
      node.type === "product"
        ? {
            // `validateArchitectureProposal` already guarantees `productId` is present for a
            // "product" node; this narrows the type for the object literal below.
            productId: node.productId as ProductId,
            label: node.label,
            description: node.description ?? "",
          }
        : { kind: "external-actor" as const, label: node.label },
  }));

  const edges = proposal.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    data: { relationship: edge.type, label: edge.label },
  }));

  return validateGraphDocument({
    version: 1,
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
  });
}
