/**
 * The curated Cloudflare products available in the architecture palette.
 *
 * Kept intentionally small — see `catalog.ts` — rather than mirroring every product this demo's
 * own Cloudflare account could showcase.
 */
export type ProductId = "workers" | "d1" | "r2" | "kv" | "workflows";

/** Product-node metadata persisted as part of the renderer-independent graph document. */
export interface ProductNodeData {
  /** A catalog identifier, never a display label. */
  productId: ProductId;
  /** User-editable node label. */
  label: string;
  /** Short user-editable explanation of this node's role in the architecture. */
  description: string;
}

/** External-system metadata persisted for an actor node (a browser, a third-party API, etc). */
export interface ActorNodeData {
  /** User-editable actor label. */
  label: string;
  /** Marks this node as an external actor rather than a Cloudflare product. */
  kind: "external-actor";
}

/** Persisted edge metadata for the two semantic relationship types. */
export interface ArchitectureEdgeData {
  /** Semantic type rendered as both edge color and edge label. */
  relationship: "request" | "event";
  /** User-visible description of the connection. */
  label: string;
}

/** A graph coordinate independent of any browser viewport. */
export interface GraphPoint {
  /** Horizontal graph-space coordinate. */
  x: number;
  /** Vertical graph-space coordinate. */
  y: number;
}

/**
 * A product or external actor represented on the canvas.
 *
 * Deliberately a plain, minimal, JSON-serializable shape rather than an alias of Vue Flow's own
 * `Node<Data, CustomEvents, Type>` (the approach `spikes/06-architect-vue-editor/REPORT.md`
 * used for its local-only spike). This type crosses the Worker/`DiagramRoom` RPC boundary
 * (`../worker/diagram-room.ts`), and Vue Flow's runtime `Node` type includes optional function
 * fields (`class`/`style` callbacks, event handler maps) that made Cloudflare's RPC
 * serializability type-checking recurse into "Type instantiation is excessively deep" errors
 * when used as a Durable Object method parameter/return type. Every field Vue Flow actually
 * requires (`id`, `position`) is present here, and every field this type adds (`type`, `data`)
 * is one Vue Flow already declares optional, so this remains a valid, directly assignable node
 * for `<VueFlow :nodes="...">` — see `../client/components/diagrams/DiagramCanvas.vue`.
 */
export interface ArchitectureNode {
  /** Unique node id, stable across edits. */
  id: string;
  /** Discriminates product nodes (catalog-backed) from external-actor nodes. */
  type: "product" | "actor";
  /** Current graph-space position. */
  position: GraphPoint;
  /** Type-specific node data. */
  data: ProductNodeData | ActorNodeData;
}

/** A typed, labeled connection between two graph nodes. Renderer-independent — see {@link ArchitectureNode}. */
export interface ArchitectureEdge {
  /** Unique edge id, stable across edits. */
  id: string;
  /** Source node id. Must reference an existing, distinct node. */
  source: string;
  /** Target node id. Must reference an existing, distinct node. */
  target: string;
  /** Discriminates the two supported semantic relationships. */
  type: "request" | "event";
  /** Type-specific edge data. */
  data: ArchitectureEdgeData;
}

/** A Vue Flow viewport, decoupled from `@vue-flow/core`'s own `ViewportTransform` type for the same reason as {@link ArchitectureNode}. */
export interface GraphViewport {
  /** Horizontal pan offset. */
  x: number;
  /** Vertical pan offset. */
  y: number;
  /** Zoom factor. */
  zoom: number;
}

/**
 * Versioned, renderer-independent graph document persisted by `DiagramRoom`.
 *
 * This is the exact contract measured in `spikes/06-architect-vue-editor/REPORT.md`: products,
 * external actors, typed edges, and the last editor viewport. Vue Flow-specific selection state
 * never appears here.
 */
export interface GraphDocument {
  /** Enables validation and future migrations. Only version 1 is currently supported. */
  version: 1;
  /** Canvas nodes without Vue Flow's ephemeral selection state. */
  nodes: ArchitectureNode[];
  /** Typed, labeled graph relationships. */
  edges: ArchitectureEdge[];
  /** Last editor viewport. Client-local presentation state, not a collaboratively edited field. */
  viewport: GraphViewport;
}
