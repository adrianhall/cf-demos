/**
 * Blueprint template definitions.
 *
 * Blueprints are pre-built diagram templates representing common Cloudflare
 * architecture patterns. They are hard-coded as static data rather than stored
 * in D1. "Start from blueprint" copies the blueprint's `graphData` into a new
 * diagram row.
 */

/** A pre-built architecture diagram template. */
export interface Blueprint {
  /** Stable slug identifier (e.g. "api-gateway"). */
  id: string;
  /** Human-readable template name. */
  title: string;
  /** Short summary of the architecture pattern. */
  description: string;
  /** Grouping category (e.g. "Serverless", "AI", "Media"). */
  category: string;
  /** Pre-built React Flow JSON (nodes, edges, viewport) as a serialised string. */
  graphData: string;
}

// ---------------------------------------------------------------------------
// Helper to build graphData JSON strings
// ---------------------------------------------------------------------------

interface NodeDef {
  id: string;
  x: number;
  y: number;
  typeId: string;
  label: string;
}

interface EdgeDef {
  id: string;
  source: string;
  target: string;
  edgeType: "data-flow" | "service-binding" | "trigger" | "external";
  label?: string;
}

function buildGraphData(nodes: NodeDef[], edges: EdgeDef[]): string {
  return JSON.stringify({
    nodes: nodes.map((n) => ({
      id: n.id,
      type: "cf-node",
      position: { x: n.x, y: n.y },
      data: { typeId: n.typeId, label: n.label, description: "" },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: "cf-edge",
      data: { edgeType: e.edgeType, ...(e.label ? { label: e.label } : {}) },
    })),
    viewport: { x: 0, y: 0, zoom: 1 },
  });
}

// ---------------------------------------------------------------------------
// Blueprint definitions
// ---------------------------------------------------------------------------

/** All available blueprint templates. */
export const BLUEPRINTS: Blueprint[] = [
  // 1. API Gateway
  {
    id: "api-gateway",
    title: "API Gateway",
    description:
      "Route API traffic through a central gateway Worker to backend microservices via service bindings, with D1 and KV for persistence.",
    category: "Serverless",
    graphData: buildGraphData(
      [
        {
          id: "client",
          x: 250,
          y: 0,
          typeId: "client-browser",
          label: "Client (Browser)",
        },
        {
          id: "gateway",
          x: 250,
          y: 150,
          typeId: "worker-hono",
          label: "API Gateway",
        },
        {
          id: "auth-svc",
          x: 0,
          y: 300,
          typeId: "worker-hono",
          label: "Auth Service",
        },
        {
          id: "data-svc",
          x: 250,
          y: 300,
          typeId: "worker-hono",
          label: "Data Service",
        },
        {
          id: "notify-svc",
          x: 500,
          y: 300,
          typeId: "worker-hono",
          label: "Notification Service",
        },
        { id: "cache", x: 0, y: 450, typeId: "kv", label: "Workers KV" },
        { id: "db", x: 250, y: 450, typeId: "d1", label: "D1 Database" },
      ],
      [
        {
          id: "e1",
          source: "client",
          target: "gateway",
          edgeType: "data-flow",
          label: "HTTPS",
        },
        {
          id: "e2",
          source: "gateway",
          target: "auth-svc",
          edgeType: "service-binding",
        },
        {
          id: "e3",
          source: "gateway",
          target: "data-svc",
          edgeType: "service-binding",
        },
        {
          id: "e4",
          source: "gateway",
          target: "notify-svc",
          edgeType: "service-binding",
        },
        { id: "e5", source: "data-svc", target: "db", edgeType: "data-flow" },
        {
          id: "e6",
          source: "auth-svc",
          target: "cache",
          edgeType: "data-flow",
        },
      ],
    ),
  },

  // 2. Full-Stack Web App
  {
    id: "fullstack-app",
    title: "Full-Stack Web App",
    description:
      "A server-rendered web application with Pages or Workers for the frontend, backed by D1, R2, and KV.",
    category: "Serverless",
    graphData: buildGraphData(
      [
        {
          id: "browser",
          x: 250,
          y: 0,
          typeId: "client-browser",
          label: "Client (Browser)",
        },
        { id: "cdn", x: 250, y: 150, typeId: "cdn", label: "CDN / Cache" },
        {
          id: "app",
          x: 250,
          y: 300,
          typeId: "worker-astro",
          label: "Astro (SSR)",
        },
        { id: "db", x: 0, y: 450, typeId: "d1", label: "D1 Database" },
        { id: "storage", x: 250, y: 450, typeId: "r2", label: "R2 Storage" },
        { id: "kv", x: 500, y: 450, typeId: "kv", label: "Workers KV" },
      ],
      [
        {
          id: "e1",
          source: "browser",
          target: "cdn",
          edgeType: "data-flow",
          label: "HTTPS",
        },
        { id: "e2", source: "cdn", target: "app", edgeType: "data-flow" },
        { id: "e3", source: "app", target: "db", edgeType: "data-flow" },
        { id: "e4", source: "app", target: "storage", edgeType: "data-flow" },
        { id: "e5", source: "app", target: "kv", edgeType: "data-flow" },
      ],
    ),
  },

  // 3. AI RAG Pipeline
  {
    id: "ai-rag",
    title: "AI RAG Pipeline",
    description:
      "Retrieval-augmented generation pipeline using Workers AI, Vectorize for embeddings, D1 for source data, and AI Gateway for observability.",
    category: "AI",
    graphData: buildGraphData(
      [
        {
          id: "client",
          x: 250,
          y: 0,
          typeId: "client-browser",
          label: "Client (Browser)",
        },
        {
          id: "worker",
          x: 250,
          y: 150,
          typeId: "worker-hono",
          label: "RAG Worker",
        },
        { id: "ai", x: 0, y: 300, typeId: "workers-ai", label: "Workers AI" },
        {
          id: "vectorize",
          x: 250,
          y: 300,
          typeId: "vectorize",
          label: "Vectorize",
        },
        { id: "db", x: 500, y: 300, typeId: "d1", label: "D1 (Source Data)" },
        {
          id: "ai-gw",
          x: 0,
          y: 450,
          typeId: "ai-gateway",
          label: "AI Gateway",
        },
      ],
      [
        {
          id: "e1",
          source: "client",
          target: "worker",
          edgeType: "data-flow",
          label: "Query",
        },
        {
          id: "e2",
          source: "worker",
          target: "vectorize",
          edgeType: "data-flow",
          label: "Embed & search",
        },
        {
          id: "e3",
          source: "worker",
          target: "db",
          edgeType: "data-flow",
          label: "Fetch context",
        },
        {
          id: "e4",
          source: "worker",
          target: "ai",
          edgeType: "data-flow",
          label: "Inference",
        },
        {
          id: "e5",
          source: "ai",
          target: "ai-gw",
          edgeType: "data-flow",
          label: "Observe",
        },
      ],
    ),
  },

  // 4. Event-Driven Processing
  {
    id: "event-driven",
    title: "Event-Driven Processing",
    description:
      "Decouple producers from consumers using Queues for async message processing, with R2 and D1 as sinks.",
    category: "Serverless",
    graphData: buildGraphData(
      [
        {
          id: "producer",
          x: 125,
          y: 0,
          typeId: "worker",
          label: "Producer Worker",
        },
        { id: "queue", x: 125, y: 150, typeId: "queues", label: "Queues" },
        {
          id: "consumer",
          x: 125,
          y: 300,
          typeId: "worker",
          label: "Consumer Worker",
        },
        { id: "storage", x: 0, y: 450, typeId: "r2", label: "R2 Storage" },
        { id: "db", x: 250, y: 450, typeId: "d1", label: "D1 Database" },
      ],
      [
        {
          id: "e1",
          source: "producer",
          target: "queue",
          edgeType: "data-flow",
          label: "Enqueue",
        },
        {
          id: "e2",
          source: "queue",
          target: "consumer",
          edgeType: "trigger",
          label: "Consume",
        },
        {
          id: "e3",
          source: "consumer",
          target: "storage",
          edgeType: "data-flow",
        },
        { id: "e4", source: "consumer", target: "db", edgeType: "data-flow" },
      ],
    ),
  },

  // 5. Real-Time Collaboration
  {
    id: "realtime-collab",
    title: "Real-Time Collaboration",
    description:
      "WebSocket-powered real-time features using Durable Objects for coordination and D1 for persistence.",
    category: "Serverless",
    graphData: buildGraphData(
      [
        {
          id: "client1",
          x: 0,
          y: 0,
          typeId: "client-browser",
          label: "Client A",
        },
        {
          id: "client2",
          x: 250,
          y: 0,
          typeId: "client-browser",
          label: "Client B",
        },
        {
          id: "worker",
          x: 125,
          y: 150,
          typeId: "worker-hono",
          label: "WS Router",
        },
        {
          id: "do",
          x: 125,
          y: 300,
          typeId: "durable-object",
          label: "Durable Object",
        },
        { id: "db", x: 125, y: 450, typeId: "d1", label: "D1 Database" },
      ],
      [
        {
          id: "e1",
          source: "client1",
          target: "worker",
          edgeType: "data-flow",
          label: "WebSocket",
        },
        {
          id: "e2",
          source: "client2",
          target: "worker",
          edgeType: "data-flow",
          label: "WebSocket",
        },
        {
          id: "e3",
          source: "worker",
          target: "do",
          edgeType: "service-binding",
        },
        {
          id: "e4",
          source: "do",
          target: "db",
          edgeType: "data-flow",
          label: "Persist",
        },
      ],
    ),
  },

  // 6. Multi-Tenant SaaS
  {
    id: "multi-tenant-saas",
    title: "Multi-Tenant SaaS",
    description:
      "Isolate tenant workloads using Workers for Platforms with per-tenant D1 and KV bindings, routed by a central dispatcher.",
    category: "Serverless",
    graphData: buildGraphData(
      [
        {
          id: "client",
          x: 375,
          y: 0,
          typeId: "client-browser",
          label: "Client (Browser)",
        },
        {
          id: "router",
          x: 375,
          y: 150,
          typeId: "worker-hono",
          label: "Router Worker",
        },
        {
          id: "platform",
          x: 375,
          y: 300,
          typeId: "workers-for-platforms",
          label: "Workers for Platforms",
        },
        { id: "tenant-a-db", x: 0, y: 450, typeId: "d1", label: "Tenant A DB" },
        {
          id: "tenant-a-kv",
          x: 250,
          y: 450,
          typeId: "kv",
          label: "Tenant A KV",
        },
        {
          id: "tenant-b-db",
          x: 500,
          y: 450,
          typeId: "d1",
          label: "Tenant B DB",
        },
        {
          id: "tenant-b-kv",
          x: 750,
          y: 450,
          typeId: "kv",
          label: "Tenant B KV",
        },
      ],
      [
        {
          id: "e1",
          source: "client",
          target: "router",
          edgeType: "data-flow",
          label: "HTTPS",
        },
        {
          id: "e2",
          source: "router",
          target: "platform",
          edgeType: "service-binding",
          label: "Dispatch",
        },
        {
          id: "e3",
          source: "platform",
          target: "tenant-a-db",
          edgeType: "data-flow",
        },
        {
          id: "e4",
          source: "platform",
          target: "tenant-a-kv",
          edgeType: "data-flow",
        },
        {
          id: "e5",
          source: "platform",
          target: "tenant-b-db",
          edgeType: "data-flow",
        },
        {
          id: "e6",
          source: "platform",
          target: "tenant-b-kv",
          edgeType: "data-flow",
        },
      ],
    ),
  },

  // 7. Media Processing Pipeline
  {
    id: "media-pipeline",
    title: "Media Processing Pipeline",
    description:
      "Ingest, process, and deliver media assets through Stream and Images, stored in R2 and served via CDN.",
    category: "Media",
    graphData: buildGraphData(
      [
        {
          id: "client",
          x: 125,
          y: 0,
          typeId: "client-browser",
          label: "Client (Browser)",
        },
        {
          id: "worker",
          x: 125,
          y: 150,
          typeId: "worker-hono",
          label: "Upload Worker",
        },
        { id: "stream", x: 0, y: 300, typeId: "stream", label: "Stream" },
        { id: "images", x: 250, y: 300, typeId: "images", label: "Images" },
        { id: "storage", x: 125, y: 450, typeId: "r2", label: "R2 Storage" },
        { id: "cdn", x: 125, y: 600, typeId: "cdn", label: "CDN / Cache" },
      ],
      [
        {
          id: "e1",
          source: "client",
          target: "worker",
          edgeType: "data-flow",
          label: "Upload",
        },
        {
          id: "e2",
          source: "worker",
          target: "stream",
          edgeType: "data-flow",
          label: "Video",
        },
        {
          id: "e3",
          source: "worker",
          target: "images",
          edgeType: "data-flow",
          label: "Image",
        },
        {
          id: "e4",
          source: "stream",
          target: "storage",
          edgeType: "data-flow",
        },
        {
          id: "e5",
          source: "images",
          target: "storage",
          edgeType: "data-flow",
        },
        {
          id: "e6",
          source: "storage",
          target: "cdn",
          edgeType: "data-flow",
          label: "Serve",
        },
      ],
    ),
  },

  // 8. Backend for Frontend (BFF)
  {
    id: "bff",
    title: "Backend for Frontend",
    description:
      "Dedicated BFF Workers for web and mobile clients, aggregating shared backend services with a common D1 database.",
    category: "Serverless",
    graphData: buildGraphData(
      [
        {
          id: "web-client",
          x: 0,
          y: 0,
          typeId: "client-browser",
          label: "Client (Web)",
        },
        {
          id: "mobile-client",
          x: 250,
          y: 0,
          typeId: "client-mobile",
          label: "Client (Mobile)",
        },
        {
          id: "bff-web",
          x: 0,
          y: 150,
          typeId: "worker-hono",
          label: "BFF (Web)",
        },
        {
          id: "bff-mobile",
          x: 250,
          y: 150,
          typeId: "worker-hono",
          label: "BFF (Mobile)",
        },
        {
          id: "user-svc",
          x: 0,
          y: 300,
          typeId: "worker-hono",
          label: "User Service",
        },
        {
          id: "order-svc",
          x: 250,
          y: 300,
          typeId: "worker-hono",
          label: "Order Service",
        },
        { id: "db", x: 125, y: 450, typeId: "d1", label: "D1 Database" },
      ],
      [
        {
          id: "e1",
          source: "web-client",
          target: "bff-web",
          edgeType: "data-flow",
          label: "HTTPS",
        },
        {
          id: "e2",
          source: "mobile-client",
          target: "bff-mobile",
          edgeType: "data-flow",
          label: "HTTPS",
        },
        {
          id: "e3",
          source: "bff-web",
          target: "user-svc",
          edgeType: "service-binding",
        },
        {
          id: "e4",
          source: "bff-web",
          target: "order-svc",
          edgeType: "service-binding",
        },
        {
          id: "e5",
          source: "bff-mobile",
          target: "user-svc",
          edgeType: "service-binding",
        },
        {
          id: "e6",
          source: "bff-mobile",
          target: "order-svc",
          edgeType: "service-binding",
        },
        { id: "e7", source: "user-svc", target: "db", edgeType: "data-flow" },
        { id: "e8", source: "order-svc", target: "db", edgeType: "data-flow" },
      ],
    ),
  },
];

/** Lookup map from blueprint ID to its definition. */
export const BLUEPRINT_MAP = new Map(BLUEPRINTS.map((b) => [b.id, b]));
