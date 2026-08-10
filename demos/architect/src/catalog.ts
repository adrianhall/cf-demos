/**
 * Cloudflare product catalog — node types, edge types, and category metadata.
 *
 * This module is the single source of truth for every service that can appear
 * on the canvas. It is consumed by the React Flow node/edge renderers, the
 * service palette sidebar, the auto-layout engine, and (post-MVP) the AI
 * prompt builder and project scaffold generator.
 */

/** Broad grouping for Cloudflare product nodes. */
export type NodeCategory =
  | "compute"
  | "storage"
  | "ai"
  | "media"
  | "network"
  | "external";

/** Definition of a single connection handle (port) on a node. */
export interface HandleDef {
  /** Unique handle identifier within the node (e.g. "target-top"). */
  id: string;
  /** Whether this handle accepts incoming ("target") or outgoing ("source") connections. */
  type: "source" | "target";
  /** Edge of the node where the handle is rendered. */
  position: "top" | "bottom" | "left" | "right";
}

/** Icon style for a documentation link: open-book or video. */
export type DocLinkIcon = "doc" | "video";

/**
 * A node type's icon: either a vendored official Cloudflare product glyph, or a generic
 * `react-feather` icon. `kind: "feather"` covers two cases: the four "External / Generic"
 * category node types, which aren't Cloudflare products and so have no official icon to begin
 * with; and `cron-trigger`, which -- despite being `category: "compute"` -- has no official icon
 * of its own either, since it's a Workers trigger configuration, not a standalone product listed
 * in Cloudflare's icon set (see its own catalog entry below for why reusing the Workers glyph
 * would be misleading here).
 *
 * `kind: "svg"` resolves `name` to `src/client/icons/<name>.svg` -- byte-identical copies of
 * Cloudflare's own `cloudflare-docs` repository icon set (`~/repos/adrianhall/cloudflare-docs/
 * src/icons/`), rendered inline by `src/client/components/ProductIcon.tsx` so they can be
 * recolored via `currentColor` and survive `ExportButton.tsx`'s `html-to-image` PNG/SVG capture
 * (see docs/DECISIONS.md). `kind: "feather"` resolves `name` to a named export of `react-feather`
 * (`ProductIcon.tsx`'s own small `FEATHER_ICONS` map, not every icon the library ships).
 */
export type ProductIcon =
  | { kind: "svg"; name: string }
  | { kind: "feather"; name: string };

/** External documentation or tutorial link shown in the properties panel. */
export interface DocLink {
  /** Icon rendered next to the link. */
  icon: DocLinkIcon;
  /** Display text for the link. */
  title: string;
  /** Full URL opened in a new tab when clicked. */
  url: string;
}

/** Static definition of a Cloudflare product node type in the catalog. */
export interface NodeTypeDef {
  /** Machine-readable identifier (e.g. "worker", "d1"). Used as the key in React Flow `data.typeId`. */
  typeId: string;
  /** Human-readable product name shown in the palette and on the canvas. */
  label: string;
  /** Category this product belongs to, used for palette grouping and color coding. */
  category: NodeCategory;
  /** Icon rendered on the canvas node and in the service palette. */
  icon: ProductIcon;
  /** Short description shown in palette tooltips. */
  description: string;
  /** Default connection handles (ports) for new instances of this node type. */
  defaultHandles: HandleDef[];
  /** Corresponding `wrangler.toml` binding type, used by the future scaffold generator. */
  wranglerBinding?: string;
  /** Code template identifier for the scaffold generator (e.g. "vanilla", "hono", "astro"). */
  scaffoldTemplate?: string;
  /** Documentation and tutorial links shown in the properties panel. */
  docLinks?: DocLink[];
}

/** Static definition of a connection edge type in the catalog. */
export interface EdgeTypeDef {
  /** Machine-readable identifier (e.g. "data-flow"). Stored in `edge.data.edgeType`. */
  edgeType: string;
  /** Human-readable label shown in the properties panel edge type selector. */
  label: string;
  /** CSS stroke style: solid, dashed, or dotted. */
  style: "solid" | "dashed" | "dotted";
  /** Whether the edge stroke is animated (moving dashes). */
  animated: boolean;
  /** Whether an arrowhead marker is drawn at the target end. */
  markerEnd: boolean;
  /** Default stroke colour (hex). */
  color: string;
  /** Short description of this edge type's purpose. */
  description: string;
  /** Wrangler binding type for the future scaffold generator (e.g. "service", "http"). */
  bindingType?: string;
}

/**
 * Standard four-handle layout used by most node types.
 * Target handles on top and left; source handles on bottom and right.
 */
const defaultHandles: HandleDef[] = [
  { id: "target-top", type: "target", position: "top" },
  { id: "source-bottom", type: "source", position: "bottom" },
  { id: "target-left", type: "target", position: "left" },
  { id: "source-right", type: "source", position: "right" },
];

/** Shorthand for a vendored official Cloudflare icon (`src/client/icons/<name>.svg`). */
function svgIcon(name: string): ProductIcon {
  return { kind: "svg", name };
}

/** Shorthand for a generic `react-feather` icon (the "External / Generic" category only). */
function featherIcon(name: string): ProductIcon {
  return { kind: "feather", name };
}

/**
 * Hex colour associated with each node category, used for borders, handles, the palette category
 * bar, and the minimap. `storage` and `network` are darkened from their original brand-palette
 * values (`#10B981`, `#F59E0B`) -- at full opacity those computed to only ~2.5:1 and ~2.2:1
 * against a white canvas, below WCAG 1.4.11's 3:1 non-text contrast minimum for a node's border,
 * which is the only visual cue distinguishing a node from the canvas when unselected
 * (`../client/components/editor/nodes/CFNode.tsx`). The other four categories already clear 3:1
 * at full opacity and are unchanged.
 */
export const CATEGORY_COLORS: Record<NodeCategory, string> = {
  compute: "#3B82F6",
  storage: "#0D9467",
  ai: "#8B5CF6",
  media: "#EC4899",
  network: "#B87608",
  external: "#6B7280",
};

/** Human-readable label for each node category, shown in the palette headers. */
export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  compute: "Compute",
  storage: "Storage & Data",
  ai: "AI",
  media: "Media",
  network: "Networking & Security",
  external: "External / Generic",
};

/** Complete list of all 42 Cloudflare product node types available on the canvas -- see
 * Issue 7 (docs/09-ARCHITECT.md Phase 7) for the reconciliation against the current product set
 * and icon set (`~/repos/adrianhall/cloudflare-docs/src/icons/`) that grew it from 32.
 *
 * Known icon collisions: Cloudflare's own icon set reuses the same glyph across
 * Workers/Workflows/Workers VPC, R2/R2 Data Catalog, Containers/Sandbox, Agents/AI Gateway, and
 * Email Routing/Email Service. This catalog uses the official glyph as-is in every case rather
 * than inventing a glyph Cloudflare itself doesn't provide -- each pair still reads as distinct
 * on canvas via its category color, accent border, and label. */
export const NODE_TYPES: NodeTypeDef[] = [
  // Compute
  {
    typeId: "worker",
    label: "Workers",
    category: "compute",
    icon: svgIcon("workers"),
    description: "Cloudflare Workers serverless compute",
    defaultHandles,
    wranglerBinding: "worker",
    scaffoldTemplate: "vanilla",
    docLinks: [
      {
        icon: "doc",
        title: "Workers Docs",
        url: "https://developers.cloudflare.com/workers/",
      },
    ],
  },
  {
    typeId: "worker-hono",
    label: "Workers (Hono)",
    category: "compute",
    icon: svgIcon("workers"),
    description: "API Worker powered by the Hono routing framework",
    defaultHandles,
    wranglerBinding: "worker",
    scaffoldTemplate: "hono",
    docLinks: [
      {
        icon: "doc",
        title: "Workers Docs",
        url: "https://developers.cloudflare.com/workers/",
      },
      { icon: "doc", title: "Hono Docs", url: "https://hono.dev/docs/" },
    ],
  },
  {
    typeId: "worker-astro",
    label: "Workers (Astro)",
    category: "compute",
    icon: svgIcon("workers"),
    description: "Web application with Astro SSR on Cloudflare Workers",
    defaultHandles,
    wranglerBinding: "worker",
    scaffoldTemplate: "astro",
    docLinks: [
      {
        icon: "doc",
        title: "Workers Docs",
        url: "https://developers.cloudflare.com/workers/",
      },
      { icon: "doc", title: "Astro Docs", url: "https://docs.astro.build/" },
    ],
  },
  {
    typeId: "pages",
    label: "Pages",
    category: "compute",
    icon: svgIcon("pages"),
    description: "Cloudflare Pages for static sites and SSR",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Pages Docs",
        url: "https://developers.cloudflare.com/pages/",
      },
    ],
  },
  {
    typeId: "durable-object",
    label: "Durable Objects",
    category: "compute",
    icon: svgIcon("durable-objects"),
    description: "Stateful serverless objects with transactional storage",
    defaultHandles,
    wranglerBinding: "durable_objects",
    docLinks: [
      {
        icon: "doc",
        title: "Durable Objects Docs",
        url: "https://developers.cloudflare.com/durable-objects/",
      },
    ],
  },
  {
    typeId: "workflow",
    label: "Workflows",
    category: "compute",
    icon: svgIcon("workflows"),
    description: "Durable execution workflows",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Workflows Docs",
        url: "https://developers.cloudflare.com/workflows/",
      },
    ],
  },
  {
    typeId: "workers-for-platforms",
    label: "Workers for Platforms",
    category: "compute",
    icon: svgIcon("cloudflare-for-platforms"),
    description: "Multi-tenant Workers platform",
    defaultHandles,
    wranglerBinding: "dispatch_namespaces",
    docLinks: [
      {
        icon: "doc",
        title: "Workers for Platforms Docs",
        url: "https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/",
      },
    ],
  },
  {
    typeId: "cron-trigger",
    label: "Cron Trigger",
    category: "compute",
    // No official Cloudflare product icon exists for this -- it's a Workers trigger
    // configuration, not a standalone product with its own catalog entry in
    // `~/repos/adrianhall/cloudflare-docs/src/icons/`. A generic clock reads more honestly than
    // reusing the Workers glyph, which would visually collide with the three Workers nodes above.
    icon: featherIcon("Clock"),
    description: "Scheduled Worker execution via cron",
    defaultHandles: [
      { id: "source-bottom", type: "source", position: "bottom" },
      { id: "source-right", type: "source", position: "right" },
    ],
    docLinks: [
      {
        icon: "doc",
        title: "Cron Triggers Docs",
        url: "https://developers.cloudflare.com/workers/configuration/cron-triggers/",
      },
    ],
  },
  {
    typeId: "containers",
    label: "Containers",
    category: "compute",
    icon: svgIcon("containers"),
    description: "Run full containers alongside Workers",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Containers Docs",
        url: "https://developers.cloudflare.com/containers/",
      },
    ],
  },
  {
    typeId: "sandbox",
    label: "Sandbox",
    category: "compute",
    icon: svgIcon("sandbox"),
    description: "Sandboxed containers for executing untrusted code",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Sandbox SDK Docs",
        url: "https://developers.cloudflare.com/sandbox/",
      },
    ],
  },

  // Storage & Data
  {
    typeId: "d1",
    label: "D1 Database",
    category: "storage",
    icon: svgIcon("d1"),
    description: "Serverless SQLite database at the edge",
    defaultHandles,
    wranglerBinding: "d1_databases",
    docLinks: [
      {
        icon: "doc",
        title: "D1 Docs",
        url: "https://developers.cloudflare.com/d1/",
      },
    ],
  },
  {
    typeId: "kv",
    label: "Workers KV",
    category: "storage",
    icon: svgIcon("kv"),
    description: "Global low-latency key-value store",
    defaultHandles,
    wranglerBinding: "kv_namespaces",
    docLinks: [
      {
        icon: "doc",
        title: "KV Docs",
        url: "https://developers.cloudflare.com/kv/",
      },
    ],
  },
  {
    typeId: "r2",
    label: "R2 Storage",
    category: "storage",
    icon: svgIcon("r2"),
    description: "S3-compatible object storage with zero egress fees",
    defaultHandles,
    wranglerBinding: "r2_buckets",
    docLinks: [
      {
        icon: "doc",
        title: "R2 Docs",
        url: "https://developers.cloudflare.com/r2/",
      },
    ],
  },
  {
    typeId: "queues",
    label: "Queues",
    category: "storage",
    icon: svgIcon("queues"),
    description: "Message queues for async processing",
    defaultHandles,
    wranglerBinding: "queues",
    docLinks: [
      {
        icon: "doc",
        title: "Queues Docs",
        url: "https://developers.cloudflare.com/queues/",
      },
    ],
  },
  {
    typeId: "hyperdrive",
    label: "Hyperdrive",
    category: "storage",
    icon: svgIcon("hyperdrive"),
    description: "Connection pooling and caching for external databases",
    defaultHandles,
    wranglerBinding: "hyperdrive",
    docLinks: [
      {
        icon: "doc",
        title: "Hyperdrive Docs",
        url: "https://developers.cloudflare.com/hyperdrive/",
      },
    ],
  },
  {
    typeId: "analytics-engine",
    label: "Analytics Engine",
    category: "storage",
    icon: svgIcon("analytics"),
    description: "High-cardinality time-series analytics",
    defaultHandles,
    wranglerBinding: "analytics_engine_datasets",
    docLinks: [
      {
        icon: "doc",
        title: "Analytics Engine Docs",
        url: "https://developers.cloudflare.com/analytics/analytics-engine/",
      },
    ],
  },
  {
    typeId: "vectorize",
    label: "Vectorize",
    category: "storage",
    icon: svgIcon("vectorize"),
    description: "Vector database for AI embeddings",
    defaultHandles,
    wranglerBinding: "vectorize",
    docLinks: [
      {
        icon: "doc",
        title: "Vectorize Docs",
        url: "https://developers.cloudflare.com/vectorize/",
      },
    ],
  },
  {
    typeId: "pipelines",
    label: "Pipelines",
    category: "storage",
    icon: svgIcon("pipelines"),
    description: "Ingest and transform streaming data into R2",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Pipelines Docs",
        url: "https://developers.cloudflare.com/pipelines/",
      },
    ],
  },
  {
    typeId: "r2-sql",
    label: "R2 SQL",
    category: "storage",
    icon: svgIcon("r2-sql"),
    description: "Serverless SQL query engine for R2 data",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "R2 SQL Docs",
        url: "https://developers.cloudflare.com/r2-sql/",
      },
    ],
  },
  {
    typeId: "r2-data-catalog",
    label: "R2 Data Catalog",
    category: "storage",
    icon: svgIcon("r2-data-catalog"),
    description: "Managed Apache Iceberg catalog for R2",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "R2 Data Catalog Docs",
        url: "https://developers.cloudflare.com/r2-data-catalog/",
      },
    ],
  },
  {
    typeId: "secrets-store",
    label: "Secrets Store",
    category: "storage",
    icon: svgIcon("secrets-store"),
    description: "Centralized, account-level secret management",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Secrets Store Docs",
        url: "https://developers.cloudflare.com/secrets-store/",
      },
    ],
  },

  // AI
  {
    typeId: "workers-ai",
    label: "Workers AI",
    category: "ai",
    icon: svgIcon("workers-ai"),
    description: "Run AI models on Cloudflare's GPU network",
    defaultHandles,
    wranglerBinding: "ai",
    docLinks: [
      {
        icon: "doc",
        title: "Workers AI Docs",
        url: "https://developers.cloudflare.com/workers-ai/",
      },
    ],
  },
  {
    typeId: "ai-gateway",
    label: "AI Gateway",
    category: "ai",
    icon: svgIcon("ai-gateway"),
    description: "Proxy, cache, and observe AI API calls",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "AI Gateway Docs",
        url: "https://developers.cloudflare.com/ai-gateway/",
      },
    ],
  },
  {
    // Renamed from CF-Architect's "AutoRAG" (Issue 7, docs/09-ARCHITECT.md Phase 7):
    // Cloudflare renamed the product itself to "AI Search". `typeId` stays "autorag" so
    // previously saved diagrams (`graph_data` JSON referencing this typeId) keep resolving to a
    // valid catalog entry -- only the label/description/icon/docLinks, the user-facing surface,
    // change.
    typeId: "autorag",
    label: "AI Search",
    category: "ai",
    icon: svgIcon("ai-search"),
    description: "Managed retrieval-augmented generation and search",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "AI Search Docs",
        url: "https://developers.cloudflare.com/ai-search/",
      },
    ],
  },
  {
    // Renamed from CF-Architect's "Browser Rendering" (Issue 7, docs/09-ARCHITECT.md Phase 7):
    // Cloudflare renamed the product itself to "Browser Run". `typeId` stays
    // "browser-rendering" for the same saved-diagram compatibility reason as "autorag" above.
    typeId: "browser-rendering",
    label: "Browser Run",
    category: "ai",
    icon: svgIcon("browser-run"),
    description: "Headless browser for rendering and scraping",
    defaultHandles,
    wranglerBinding: "browser",
    docLinks: [
      {
        icon: "doc",
        title: "Browser Run Docs",
        url: "https://developers.cloudflare.com/browser-run/",
      },
    ],
  },
  {
    typeId: "agents",
    label: "AI Agents",
    category: "ai",
    icon: svgIcon("agents"),
    description: "Autonomous AI agents on Cloudflare",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Agents Docs",
        url: "https://developers.cloudflare.com/agents/",
      },
    ],
  },

  // Media
  {
    typeId: "images",
    label: "Images",
    category: "media",
    icon: svgIcon("images"),
    description: "On-the-fly image resizing and optimization",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Images Docs",
        url: "https://developers.cloudflare.com/images/",
      },
    ],
  },
  {
    typeId: "stream",
    label: "Stream",
    category: "media",
    icon: svgIcon("stream"),
    description: "Video encoding, storage, and delivery",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Stream Docs",
        url: "https://developers.cloudflare.com/stream/",
      },
    ],
  },
  {
    typeId: "realtime",
    label: "Realtime",
    category: "media",
    icon: svgIcon("realtime"),
    description: "Low-latency audio/video and data infrastructure",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Realtime Docs",
        url: "https://developers.cloudflare.com/realtime/",
      },
    ],
  },

  // Networking & Security
  {
    typeId: "dns",
    label: "DNS",
    category: "network",
    icon: svgIcon("dns"),
    description: "Cloudflare DNS management",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "DNS Docs",
        url: "https://developers.cloudflare.com/dns/",
      },
    ],
  },
  {
    typeId: "cdn",
    label: "CDN / Cache",
    category: "network",
    icon: svgIcon("cache"),
    description: "Global content delivery and caching",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Cache Docs",
        url: "https://developers.cloudflare.com/cache/",
      },
    ],
  },
  {
    typeId: "email-routing",
    label: "Email Routing",
    category: "network",
    icon: svgIcon("email-routing"),
    description: "Email forwarding and Worker-based processing",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Email Routing Docs",
        url: "https://developers.cloudflare.com/email-routing/",
      },
    ],
  },
  {
    typeId: "email-service",
    label: "Email Service",
    category: "network",
    icon: svgIcon("email-service"),
    description: "Send transactional email from a Worker",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Email Service Docs",
        url: "https://developers.cloudflare.com/email-service/",
      },
    ],
  },
  {
    typeId: "access",
    label: "Cloudflare Access",
    category: "network",
    icon: svgIcon("access"),
    description: "Zero Trust identity-aware proxy",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Access Docs",
        url: "https://developers.cloudflare.com/cloudflare-one/policies/access/",
      },
    ],
  },
  {
    typeId: "waf",
    label: "WAF",
    category: "network",
    icon: svgIcon("waf"),
    description: "Web Application Firewall",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "WAF Docs",
        url: "https://developers.cloudflare.com/waf/",
      },
    ],
  },
  {
    typeId: "load-balancer",
    label: "Load Balancer",
    category: "network",
    icon: svgIcon("load-balancing"),
    description: "Traffic distribution and health checks",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Load Balancing Docs",
        url: "https://developers.cloudflare.com/load-balancing/",
      },
    ],
  },
  {
    typeId: "workers-vpc",
    label: "Workers VPC",
    category: "network",
    icon: svgIcon("workers-vpc"),
    description: "Private network connectivity from Workers",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Workers VPC Docs",
        url: "https://developers.cloudflare.com/workers-vpc/",
      },
    ],
  },
  {
    typeId: "turnstile",
    label: "Turnstile",
    category: "network",
    icon: svgIcon("turnstile"),
    description: "Invisible, privacy-preserving bot protection",
    defaultHandles,
    docLinks: [
      {
        icon: "doc",
        title: "Turnstile Docs",
        url: "https://developers.cloudflare.com/turnstile/",
      },
    ],
  },

  // External / Generic -- not Cloudflare products, so these use generic `react-feather` glyphs
  // rather than an official Cloudflare icon (see `ProductIcon` above).
  {
    typeId: "external-api",
    label: "External API",
    category: "external",
    icon: featherIcon("Globe"),
    description: "Third-party API endpoint",
    defaultHandles,
  },
  {
    typeId: "client-browser",
    label: "Client (Browser)",
    category: "external",
    icon: featherIcon("Monitor"),
    description: "End-user web browser",
    defaultHandles: [
      { id: "source-bottom", type: "source", position: "bottom" },
      { id: "source-right", type: "source", position: "right" },
    ],
  },
  {
    typeId: "client-mobile",
    label: "Client (Mobile)",
    category: "external",
    icon: featherIcon("Smartphone"),
    description: "End-user mobile application",
    defaultHandles: [
      { id: "source-bottom", type: "source", position: "bottom" },
      { id: "source-right", type: "source", position: "right" },
    ],
  },
  {
    typeId: "external-db",
    label: "External Database",
    category: "external",
    icon: featherIcon("Database"),
    description: "External database (Postgres, MySQL, etc.)",
    defaultHandles,
  },
];

/** All available edge types with their visual and semantic metadata. */
export const EDGE_TYPES: EdgeTypeDef[] = [
  {
    edgeType: "data-flow",
    label: "Data Flow",
    style: "solid",
    animated: true,
    markerEnd: true,
    color: "#F6821F",
    description: "Primary data movement between services",
    bindingType: "http",
  },
  {
    edgeType: "service-binding",
    label: "Service Binding",
    style: "dashed",
    animated: false,
    markerEnd: false,
    color: "#3B82F6",
    description: "Worker-to-Worker service bindings",
    bindingType: "service",
  },
  {
    edgeType: "trigger",
    label: "Trigger",
    style: "dotted",
    animated: false,
    markerEnd: true,
    color: "#F59E0B",
    description: "Event triggers (Cron, Queue consumer, etc.)",
    bindingType: "event",
  },
  {
    edgeType: "external",
    label: "External",
    style: "solid",
    animated: false,
    markerEnd: true,
    color: "#9CA3AF",
    description: "Communication with external systems",
    bindingType: "http",
  },
];

/** O(1) lookup map from node `typeId` to its full definition. */
export const NODE_TYPE_MAP = new Map(NODE_TYPES.map((n) => [n.typeId, n]));

/** O(1) lookup map from edge `edgeType` to its full definition. */
export const EDGE_TYPE_MAP = new Map(EDGE_TYPES.map((e) => [e.edgeType, e]));

/**
 * Group all node types by their category.
 *
 * Used by the {@link ServicePalette} to render collapsible category sections.
 *
 * @returns A record keyed by `NodeCategory` with arrays of node definitions.
 */
export function getNodesByCategory(): Record<NodeCategory, NodeTypeDef[]> {
  const grouped = {} as Record<NodeCategory, NodeTypeDef[]>;
  for (const node of NODE_TYPES) {
    if (!grouped[node.category]) grouped[node.category] = [];
    grouped[node.category].push(node);
  }
  return grouped;
}
