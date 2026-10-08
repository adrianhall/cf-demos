/**
 * @file Blueprint template definitions. Blueprints are pre-built diagram templates representing
 *   common Cloudflare architecture patterns. They are hard-coded as static data rather than stored
 *   in D1. "Start from blueprint" copies the blueprint's `graphData` into a new diagram row. The
 *   server resolves a `blueprintId` against {@link BLUEPRINT_MAP} itself rather than accepting a
 *   client-supplied graph at creation time, which is why this module is shared rather than
 *   client-only: a caller naming a blueprint cannot smuggle in arbitrary graph content.
 */

import { CF_EDGE_TYPE, CF_NODE_TYPE } from './graph-element-types.ts';

/**
 * A pre-built architecture diagram template.
 */
export interface Blueprint {
  /**
   * Stable slug identifier (e.g. "api-gateway").
   */
  id: string;
  /**
   * Human-readable template name.
   */
  title: string;
  /**
   * Short summary of the architecture pattern.
   */
  description: string;
  /**
   * Grouping category (e.g. "Serverless", "AI", "Media", "Storage").
   */
  category: string;
  /**
   * Pre-built React Flow JSON (nodes, edges, viewport) as a serialised string.
   */
  graphData: string;
  /**
   * Canonical Cloudflare reference-architecture page this template models, when it has one.
   *
   * Provenance rather than decoration: these graphs are deliberate transcriptions of a published
   * architecture, so a reader who wants the prose — the numbered request flow, the trade-offs, the
   * products' own documentation — needs the page it came from. It is surfaced in the create-diagram
   * modal rather than on a gallery card, because a card is a single activation target and a link
   * inside it would be a nested interactive element.
   *
   * Absent for the templates ported from the source application, which predate this mapping and
   * correspond to no single published diagram.
   */
  referenceUrl?: string;
}

// ---------------------------------------------------------------------------
// Helper to build graphData JSON strings
// ---------------------------------------------------------------------------

/**
 * Terse authoring shape for a blueprint node, expanded into full React Flow JSON by
 * {@link buildGraphData}.
 */
interface NodeDef {
  /**
   * Node id, unique within the blueprint.
   */
  id: string;
  /**
   * Canvas x position.
   */
  x: number;
  /**
   * Canvas y position.
   */
  y: number;
  /**
   * Catalogue product type id (`./catalog.ts`'s `NodeTypeDef.typeId`).
   */
  typeId: string;
  /**
   * Display label shown on the node.
   */
  label: string;
}

/**
 * Terse authoring shape for a blueprint edge, expanded into full React Flow JSON by
 * {@link buildGraphData}.
 */
interface EdgeDef {
  /**
   * Edge id, unique within the blueprint.
   */
  id: string;
  /**
   * Source node id.
   */
  source: string;
  /**
   * Target node id.
   */
  target: string;
  /**
   * Catalogue edge type (`./catalog.ts`'s `EDGE_TYPES`).
   */
  edgeType: 'data-flow' | 'service-binding' | 'trigger' | 'external';
  /**
   * Optional edge label; omitted from the generated `data` entirely when unset.
   */
  label?: string;
}

/**
 * Expand a blueprint's terse {@link NodeDef}/{@link EdgeDef} authoring shape into the full React
 * Flow JSON (`nodes`/`edges`/`viewport`) stored as `Blueprint.graphData` and, once a diagram is
 * created from a blueprint, as a diagram's own `graph_data` column.
 *
 * @param nodes Blueprint nodes to expand.
 * @param edges Blueprint edges to expand.
 * @returns Serialized `{ nodes, edges, viewport }` JSON, ready to store as `graphData`.
 */
function buildGraphData(nodes: NodeDef[], edges: EdgeDef[]): string {
  return JSON.stringify({
    nodes: nodes.map((n) => ({
      id: n.id,
      type: CF_NODE_TYPE,
      position: { x: n.x, y: n.y },
      data: { typeId: n.typeId, label: n.label, description: '' }
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: CF_EDGE_TYPE,
      data: { edgeType: e.edgeType, ...(e.label ? { label: e.label } : {}) }
    })),
    viewport: { x: 0, y: 0, zoom: 1 }
  });
}

// ---------------------------------------------------------------------------
// Blueprint definitions
// ---------------------------------------------------------------------------

/**
 * All available blueprint templates.
 */
export const BLUEPRINTS: Blueprint[] = [
  // 1. API Gateway
  {
    id: 'api-gateway',
    title: 'API Gateway',
    description:
      'Route API traffic through a central gateway Worker to backend microservices via service bindings, with D1 and KV for persistence.',
    category: 'Serverless',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/serverless/serverless-global-apis/',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        {
          id: 'gateway',
          x: 250,
          y: 150,
          typeId: 'worker-hono',
          label: 'API Gateway'
        },
        {
          id: 'auth-svc',
          x: 0,
          y: 300,
          typeId: 'worker-hono',
          label: 'Auth Service'
        },
        {
          id: 'data-svc',
          x: 250,
          y: 300,
          typeId: 'worker-hono',
          label: 'Data Service'
        },
        {
          id: 'notify-svc',
          x: 500,
          y: 300,
          typeId: 'worker-hono',
          label: 'Notification Service'
        },
        { id: 'cache', x: 0, y: 450, typeId: 'kv', label: 'Workers KV' },
        { id: 'db', x: 250, y: 450, typeId: 'd1', label: 'D1 Database' }
      ],
      [
        {
          id: 'e1',
          source: 'client',
          target: 'gateway',
          edgeType: 'data-flow',
          label: 'HTTPS'
        },
        {
          id: 'e2',
          source: 'gateway',
          target: 'auth-svc',
          edgeType: 'service-binding'
        },
        {
          id: 'e3',
          source: 'gateway',
          target: 'data-svc',
          edgeType: 'service-binding'
        },
        {
          id: 'e4',
          source: 'gateway',
          target: 'notify-svc',
          edgeType: 'service-binding'
        },
        { id: 'e5', source: 'data-svc', target: 'db', edgeType: 'data-flow' },
        {
          id: 'e6',
          source: 'auth-svc',
          target: 'cache',
          edgeType: 'data-flow'
        }
      ]
    )
  },

  // 2. Full-Stack Web App
  {
    id: 'fullstack-app',
    title: 'Full-Stack Web App',
    description:
      'A server-rendered web application with Pages or Workers for the frontend, backed by D1, R2, and KV.',
    category: 'Serverless',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/serverless/fullstack-application/',
    graphData: buildGraphData(
      [
        {
          id: 'browser',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        { id: 'cdn', x: 250, y: 150, typeId: 'cdn', label: 'CDN / Cache' },
        {
          id: 'app',
          x: 250,
          y: 300,
          typeId: 'worker-astro',
          label: 'Astro (SSR)'
        },
        { id: 'db', x: 0, y: 450, typeId: 'd1', label: 'D1 Database' },
        { id: 'storage', x: 250, y: 450, typeId: 'r2', label: 'R2 Storage' },
        { id: 'kv', x: 500, y: 450, typeId: 'kv', label: 'Workers KV' }
      ],
      [
        {
          id: 'e1',
          source: 'browser',
          target: 'cdn',
          edgeType: 'data-flow',
          label: 'HTTPS'
        },
        { id: 'e2', source: 'cdn', target: 'app', edgeType: 'data-flow' },
        { id: 'e3', source: 'app', target: 'db', edgeType: 'data-flow' },
        { id: 'e4', source: 'app', target: 'storage', edgeType: 'data-flow' },
        { id: 'e5', source: 'app', target: 'kv', edgeType: 'data-flow' }
      ]
    )
  },

  // 3. AI RAG Pipeline
  {
    id: 'ai-rag',
    title: 'AI RAG Pipeline',
    description:
      'Retrieval-augmented generation pipeline using Workers AI, Vectorize for embeddings, D1 for source data, and AI Gateway for observability.',
    category: 'AI',
    referenceUrl: 'https://developers.cloudflare.com/reference-architecture/diagrams/ai/ai-rag/',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        {
          id: 'worker',
          x: 250,
          y: 150,
          typeId: 'worker-hono',
          label: 'RAG Worker'
        },
        { id: 'ai', x: 0, y: 300, typeId: 'workers-ai', label: 'Workers AI' },
        {
          id: 'vectorize',
          x: 250,
          y: 300,
          typeId: 'vectorize',
          label: 'Vectorize'
        },
        { id: 'db', x: 500, y: 300, typeId: 'd1', label: 'D1 (Source Data)' },
        {
          id: 'ai-gw',
          x: 0,
          y: 450,
          typeId: 'ai-gateway',
          label: 'AI Gateway'
        }
      ],
      [
        {
          id: 'e1',
          source: 'client',
          target: 'worker',
          edgeType: 'data-flow',
          label: 'Query'
        },
        {
          id: 'e2',
          source: 'worker',
          target: 'vectorize',
          edgeType: 'data-flow',
          label: 'Embed & search'
        },
        {
          id: 'e3',
          source: 'worker',
          target: 'db',
          edgeType: 'data-flow',
          label: 'Fetch context'
        },
        {
          id: 'e4',
          source: 'worker',
          target: 'ai',
          edgeType: 'data-flow',
          label: 'Inference'
        },
        {
          id: 'e5',
          source: 'ai',
          target: 'ai-gw',
          edgeType: 'data-flow',
          label: 'Observe'
        }
      ]
    )
  },

  // 4. Event-Driven Processing
  {
    id: 'event-driven',
    title: 'Event-Driven Processing',
    description:
      'Decouple producers from consumers using Queues for async message processing, with R2 and D1 as sinks.',
    category: 'Serverless',
    graphData: buildGraphData(
      [
        {
          id: 'producer',
          x: 125,
          y: 0,
          typeId: 'worker',
          label: 'Producer Worker'
        },
        { id: 'queue', x: 125, y: 150, typeId: 'queues', label: 'Queues' },
        {
          id: 'consumer',
          x: 125,
          y: 300,
          typeId: 'worker',
          label: 'Consumer Worker'
        },
        { id: 'storage', x: 0, y: 450, typeId: 'r2', label: 'R2 Storage' },
        { id: 'db', x: 250, y: 450, typeId: 'd1', label: 'D1 Database' }
      ],
      [
        {
          id: 'e1',
          source: 'producer',
          target: 'queue',
          edgeType: 'data-flow',
          label: 'Enqueue'
        },
        {
          id: 'e2',
          source: 'queue',
          target: 'consumer',
          edgeType: 'trigger',
          label: 'Consume'
        },
        {
          id: 'e3',
          source: 'consumer',
          target: 'storage',
          edgeType: 'data-flow'
        },
        { id: 'e4', source: 'consumer', target: 'db', edgeType: 'data-flow' }
      ]
    )
  },

  // 5. Real-Time Collaboration
  {
    id: 'realtime-collab',
    title: 'Real-Time Collaboration',
    description:
      'WebSocket-powered real-time features using Durable Objects for coordination and D1 for persistence.',
    category: 'Serverless',
    graphData: buildGraphData(
      [
        {
          id: 'client1',
          x: 0,
          y: 0,
          typeId: 'client-browser',
          label: 'Client A'
        },
        {
          id: 'client2',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client B'
        },
        {
          id: 'worker',
          x: 125,
          y: 150,
          typeId: 'worker-hono',
          label: 'WS Router'
        },
        {
          id: 'do',
          x: 125,
          y: 300,
          typeId: 'durable-object',
          label: 'Durable Object'
        },
        { id: 'db', x: 125, y: 450, typeId: 'd1', label: 'D1 Database' }
      ],
      [
        {
          id: 'e1',
          source: 'client1',
          target: 'worker',
          edgeType: 'data-flow',
          label: 'WebSocket'
        },
        {
          id: 'e2',
          source: 'client2',
          target: 'worker',
          edgeType: 'data-flow',
          label: 'WebSocket'
        },
        {
          id: 'e3',
          source: 'worker',
          target: 'do',
          edgeType: 'service-binding'
        },
        {
          id: 'e4',
          source: 'do',
          target: 'db',
          edgeType: 'data-flow',
          label: 'Persist'
        }
      ]
    )
  },

  // 6. Multi-Tenant SaaS
  {
    id: 'multi-tenant-saas',
    title: 'Multi-Tenant SaaS',
    description:
      'Isolate tenant workloads using Workers for Platforms with per-tenant D1 and KV bindings, routed by a central dispatcher.',
    category: 'Serverless',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/serverless/programmable-platforms/',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 375,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        {
          id: 'router',
          x: 375,
          y: 150,
          typeId: 'worker-hono',
          label: 'Router Worker'
        },
        {
          id: 'platform',
          x: 375,
          y: 300,
          typeId: 'workers-for-platforms',
          label: 'Workers for Platforms'
        },
        { id: 'tenant-a-db', x: 0, y: 450, typeId: 'd1', label: 'Tenant A DB' },
        {
          id: 'tenant-a-kv',
          x: 250,
          y: 450,
          typeId: 'kv',
          label: 'Tenant A KV'
        },
        {
          id: 'tenant-b-db',
          x: 500,
          y: 450,
          typeId: 'd1',
          label: 'Tenant B DB'
        },
        {
          id: 'tenant-b-kv',
          x: 750,
          y: 450,
          typeId: 'kv',
          label: 'Tenant B KV'
        }
      ],
      [
        {
          id: 'e1',
          source: 'client',
          target: 'router',
          edgeType: 'data-flow',
          label: 'HTTPS'
        },
        {
          id: 'e2',
          source: 'router',
          target: 'platform',
          edgeType: 'service-binding',
          label: 'Dispatch'
        },
        {
          id: 'e3',
          source: 'platform',
          target: 'tenant-a-db',
          edgeType: 'data-flow'
        },
        {
          id: 'e4',
          source: 'platform',
          target: 'tenant-a-kv',
          edgeType: 'data-flow'
        },
        {
          id: 'e5',
          source: 'platform',
          target: 'tenant-b-db',
          edgeType: 'data-flow'
        },
        {
          id: 'e6',
          source: 'platform',
          target: 'tenant-b-kv',
          edgeType: 'data-flow'
        }
      ]
    )
  },

  // 7. Media Processing Pipeline
  {
    id: 'media-pipeline',
    title: 'Media Processing Pipeline',
    description:
      'Ingest, process, and deliver media assets through Stream and Images, stored in R2 and served via CDN.',
    category: 'Media',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 125,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        {
          id: 'worker',
          x: 125,
          y: 150,
          typeId: 'worker-hono',
          label: 'Upload Worker'
        },
        { id: 'stream', x: 0, y: 300, typeId: 'stream', label: 'Stream' },
        { id: 'images', x: 250, y: 300, typeId: 'images', label: 'Images' },
        { id: 'storage', x: 125, y: 450, typeId: 'r2', label: 'R2 Storage' },
        { id: 'cdn', x: 125, y: 600, typeId: 'cdn', label: 'CDN / Cache' }
      ],
      [
        {
          id: 'e1',
          source: 'client',
          target: 'worker',
          edgeType: 'data-flow',
          label: 'Upload'
        },
        {
          id: 'e2',
          source: 'worker',
          target: 'stream',
          edgeType: 'data-flow',
          label: 'Video'
        },
        {
          id: 'e3',
          source: 'worker',
          target: 'images',
          edgeType: 'data-flow',
          label: 'Image'
        },
        {
          id: 'e4',
          source: 'stream',
          target: 'storage',
          edgeType: 'data-flow'
        },
        {
          id: 'e5',
          source: 'images',
          target: 'storage',
          edgeType: 'data-flow'
        },
        {
          id: 'e6',
          source: 'storage',
          target: 'cdn',
          edgeType: 'data-flow',
          label: 'Serve'
        }
      ]
    )
  },

  // 8. Backend for Frontend (BFF)
  {
    id: 'bff',
    title: 'Backend for Frontend',
    description:
      'Dedicated BFF Workers for web and mobile clients, aggregating shared backend services with a common D1 database.',
    category: 'Serverless',
    graphData: buildGraphData(
      [
        {
          id: 'web-client',
          x: 0,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Web)'
        },
        {
          id: 'mobile-client',
          x: 250,
          y: 0,
          typeId: 'client-mobile',
          label: 'Client (Mobile)'
        },
        {
          id: 'bff-web',
          x: 0,
          y: 150,
          typeId: 'worker-hono',
          label: 'BFF (Web)'
        },
        {
          id: 'bff-mobile',
          x: 250,
          y: 150,
          typeId: 'worker-hono',
          label: 'BFF (Mobile)'
        },
        {
          id: 'user-svc',
          x: 0,
          y: 300,
          typeId: 'worker-hono',
          label: 'User Service'
        },
        {
          id: 'order-svc',
          x: 250,
          y: 300,
          typeId: 'worker-hono',
          label: 'Order Service'
        },
        { id: 'db', x: 125, y: 450, typeId: 'd1', label: 'D1 Database' }
      ],
      [
        {
          id: 'e1',
          source: 'web-client',
          target: 'bff-web',
          edgeType: 'data-flow',
          label: 'HTTPS'
        },
        {
          id: 'e2',
          source: 'mobile-client',
          target: 'bff-mobile',
          edgeType: 'data-flow',
          label: 'HTTPS'
        },
        {
          id: 'e3',
          source: 'bff-web',
          target: 'user-svc',
          edgeType: 'service-binding'
        },
        {
          id: 'e4',
          source: 'bff-web',
          target: 'order-svc',
          edgeType: 'service-binding'
        },
        {
          id: 'e5',
          source: 'bff-mobile',
          target: 'user-svc',
          edgeType: 'service-binding'
        },
        {
          id: 'e6',
          source: 'bff-mobile',
          target: 'order-svc',
          edgeType: 'service-binding'
        },
        { id: 'e7', source: 'user-svc', target: 'db', edgeType: 'data-flow' },
        { id: 'e8', source: 'order-svc', target: 'db', edgeType: 'data-flow' }
      ]
    )
  },

  // 9. Automatic Video Captioning
  {
    id: 'ai-video-caption',
    title: 'Automatic Video Captioning',
    description:
      'Transcribe uploaded audio with a Workers AI speech-recognition model, store the subtitle track and video in R2, and serve both through the cache.',
    category: 'AI',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/ai/ai-video-caption/',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        {
          id: 'upload-worker',
          x: 250,
          y: 150,
          typeId: 'worker',
          label: 'Upload API'
        },
        {
          id: 'asr',
          x: 0,
          y: 300,
          typeId: 'workers-ai',
          label: 'Workers AI (ASR)'
        },
        {
          id: 'subtitles',
          x: 250,
          y: 450,
          typeId: 'r2',
          label: 'R2 (Subtitles)'
        },
        { id: 'video', x: 500, y: 450, typeId: 'r2', label: 'R2 (Video)' },
        { id: 'cache', x: 500, y: 150, typeId: 'cdn', label: 'Cache' }
      ],
      [
        {
          id: 'e1',
          source: 'client',
          target: 'upload-worker',
          edgeType: 'data-flow',
          label: 'POST video + audio'
        },
        {
          id: 'e2',
          source: 'upload-worker',
          target: 'asr',
          edgeType: 'data-flow',
          label: 'Transcribe'
        },
        {
          id: 'e3',
          source: 'upload-worker',
          target: 'subtitles',
          edgeType: 'data-flow',
          label: 'Store subtitles'
        },
        {
          id: 'e4',
          source: 'upload-worker',
          target: 'video',
          edgeType: 'data-flow',
          label: 'Store video'
        },
        {
          id: 'e5',
          source: 'client',
          target: 'cache',
          edgeType: 'data-flow',
          label: 'GET playback'
        },
        {
          id: 'e6',
          source: 'cache',
          target: 'video',
          edgeType: 'data-flow',
          label: 'Cache MISS'
        }
      ]
    )
  },

  // 10. Composable AI Architecture
  {
    id: 'ai-composable',
    title: 'Composable AI Architecture',
    description:
      'Separate compute, inference, vector search, and state so each layer can be a Cloudflare service or an external provider behind the same standard interfaces.',
    category: 'AI',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/ai/ai-composable/',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        {
          id: 'compute',
          x: 250,
          y: 150,
          typeId: 'worker',
          label: 'Compute (Workers)'
        },
        {
          id: 'inference',
          x: 0,
          y: 300,
          typeId: 'workers-ai',
          label: 'Inference'
        },
        {
          id: 'vector',
          x: 250,
          y: 300,
          typeId: 'vectorize',
          label: 'Vector Search'
        },
        {
          id: 'external-inference',
          x: 500,
          y: 300,
          typeId: 'external-api',
          label: 'External Inference'
        },
        { id: 'db', x: 125, y: 450, typeId: 'd1', label: 'D1 (State)' },
        { id: 'objects', x: 375, y: 450, typeId: 'r2', label: 'R2 (Data)' }
      ],
      [
        {
          id: 'e1',
          source: 'client',
          target: 'compute',
          edgeType: 'data-flow',
          label: 'HTTPS'
        },
        {
          id: 'e2',
          source: 'compute',
          target: 'inference',
          edgeType: 'data-flow',
          label: 'Binding'
        },
        { id: 'e3', source: 'compute', target: 'vector', edgeType: 'data-flow' },
        {
          id: 'e4',
          source: 'compute',
          target: 'external-inference',
          edgeType: 'external',
          label: 'REST'
        },
        { id: 'e5', source: 'compute', target: 'db', edgeType: 'data-flow' },
        { id: 'e6', source: 'compute', target: 'objects', edgeType: 'data-flow' }
      ]
    )
  },

  // 11. Content-Based Asset Creation
  {
    id: 'ai-asset-creation',
    title: 'Content-Based Asset Creation',
    description:
      'Chain Workers AI models: generate an image prompt from input text, screen it with a text-classification safety check, then render the image.',
    category: 'AI',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/ai/ai-asset-creation/',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        { id: 'api', x: 250, y: 150, typeId: 'worker', label: 'Asset API' },
        {
          id: 'prompt-model',
          x: 0,
          y: 300,
          typeId: 'workers-ai',
          label: 'Text Generation'
        },
        {
          id: 'safety-model',
          x: 250,
          y: 300,
          typeId: 'workers-ai',
          label: 'Safety Check'
        },
        {
          id: 'image-model',
          x: 500,
          y: 300,
          typeId: 'workers-ai',
          label: 'Text to Image'
        },
        { id: 'assets', x: 250, y: 450, typeId: 'r2', label: 'R2 (Assets)' }
      ],
      [
        {
          id: 'e1',
          source: 'client',
          target: 'api',
          edgeType: 'data-flow',
          label: 'POST content'
        },
        {
          id: 'e2',
          source: 'api',
          target: 'prompt-model',
          edgeType: 'data-flow',
          label: 'Generate prompt'
        },
        {
          id: 'e3',
          source: 'api',
          target: 'safety-model',
          edgeType: 'data-flow',
          label: 'Moderate'
        },
        {
          id: 'e4',
          source: 'api',
          target: 'image-model',
          edgeType: 'data-flow',
          label: 'Generate image'
        },
        { id: 'e5', source: 'api', target: 'assets', edgeType: 'data-flow' }
      ]
    )
  },

  // 12. Multi-Vendor AI Observability
  {
    id: 'ai-multivendor-observability',
    title: 'Multi-Vendor AI Observability',
    description:
      'Put AI Gateway in front of several inference providers as a forward proxy, centralising caching, rate limiting, logging, retries, and provider fallback.',
    category: 'AI',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/ai/ai-multivendor-observability-control/',
    graphData: buildGraphData(
      [
        {
          id: 'service',
          x: 250,
          y: 0,
          typeId: 'worker',
          label: 'Calling Service'
        },
        {
          id: 'gateway',
          x: 250,
          y: 150,
          typeId: 'ai-gateway',
          label: 'AI Gateway'
        },
        {
          id: 'workers-ai',
          x: 0,
          y: 300,
          typeId: 'workers-ai',
          label: 'Workers AI'
        },
        {
          id: 'vendor-a',
          x: 250,
          y: 300,
          typeId: 'external-api',
          label: 'Provider A'
        },
        {
          id: 'vendor-b',
          x: 500,
          y: 300,
          typeId: 'external-api',
          label: 'Provider B (Fallback)'
        },
        {
          id: 'analytics',
          x: 500,
          y: 0,
          typeId: 'analytics-engine',
          label: 'Analytics & Logs'
        }
      ],
      [
        {
          id: 'e1',
          source: 'service',
          target: 'gateway',
          edgeType: 'data-flow',
          label: 'Inference request'
        },
        {
          id: 'e2',
          source: 'gateway',
          target: 'workers-ai',
          edgeType: 'data-flow',
          label: 'Proxy'
        },
        { id: 'e3', source: 'gateway', target: 'vendor-a', edgeType: 'external' },
        {
          id: 'e4',
          source: 'gateway',
          target: 'vendor-b',
          edgeType: 'external',
          label: 'Fallback'
        },
        {
          id: 'e5',
          source: 'gateway',
          target: 'analytics',
          edgeType: 'data-flow',
          label: 'Metrics'
        }
      ]
    )
  },

  // 13. BigQuery to Workers AI
  {
    id: 'bigquery-workers-ai',
    title: 'BigQuery to Workers AI',
    description:
      'Run a Cron Trigger that reads Google BigQuery with a service-account JWT from Secrets Store, enriches rows through Workers AI, and fans results out to D1, KV, R2, and Vectorize.',
    category: 'AI',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/ai/bigquery-workers-ai/',
    graphData: buildGraphData(
      [
        { id: 'cron', x: 250, y: 0, typeId: 'cron-trigger', label: 'Cron Trigger' },
        {
          id: 'worker',
          x: 250,
          y: 150,
          typeId: 'worker',
          label: 'Ingest Worker'
        },
        {
          id: 'secrets',
          x: 0,
          y: 150,
          typeId: 'secrets-store',
          label: 'Secrets Store'
        },
        {
          id: 'bigquery',
          x: 500,
          y: 150,
          typeId: 'external-db',
          label: 'Google BigQuery'
        },
        { id: 'ai', x: 250, y: 300, typeId: 'workers-ai', label: 'Workers AI' },
        { id: 'db', x: 0, y: 450, typeId: 'd1', label: 'D1 Database' },
        { id: 'vectors', x: 200, y: 450, typeId: 'vectorize', label: 'Vectorize' },
        { id: 'kv', x: 400, y: 450, typeId: 'kv', label: 'Workers KV' },
        { id: 'objects', x: 600, y: 450, typeId: 'r2', label: 'R2 Storage' }
      ],
      [
        {
          id: 'e1',
          source: 'cron',
          target: 'worker',
          edgeType: 'trigger',
          label: 'Scheduled'
        },
        {
          id: 'e2',
          source: 'worker',
          target: 'secrets',
          edgeType: 'data-flow',
          label: 'Service key'
        },
        {
          id: 'e3',
          source: 'worker',
          target: 'bigquery',
          edgeType: 'external',
          label: 'Authenticated query'
        },
        {
          id: 'e4',
          source: 'worker',
          target: 'ai',
          edgeType: 'data-flow',
          label: 'Enrich'
        },
        { id: 'e5', source: 'worker', target: 'db', edgeType: 'data-flow' },
        { id: 'e6', source: 'worker', target: 'vectors', edgeType: 'data-flow' },
        { id: 'e7', source: 'worker', target: 'kv', edgeType: 'data-flow' },
        { id: 'e8', source: 'worker', target: 'objects', edgeType: 'data-flow' }
      ]
    )
  },

  // 14. Optimized Image Delivery
  {
    id: 'image-delivery-r2',
    title: 'Optimized Image Delivery',
    description:
      'Serve transformed images from cache, falling back to Cloudflare Images transformations over originals held in R2 so no resized variant is ever stored.',
    category: 'Serverless',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/content-delivery/optimizing-image-delivery-with-cloudflare-image-resizing-and-r2/',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        { id: 'cache', x: 250, y: 150, typeId: 'cdn', label: 'Cache' },
        {
          id: 'images',
          x: 250,
          y: 300,
          typeId: 'images',
          label: 'Cloudflare Images'
        },
        { id: 'origin', x: 250, y: 450, typeId: 'r2', label: 'R2 (Originals)' }
      ],
      [
        {
          id: 'e1',
          source: 'client',
          target: 'cache',
          edgeType: 'data-flow',
          label: 'GET /cdn-cgi/image/…'
        },
        {
          id: 'e2',
          source: 'cache',
          target: 'images',
          edgeType: 'data-flow',
          label: 'Cache MISS'
        },
        {
          id: 'e3',
          source: 'images',
          target: 'origin',
          edgeType: 'data-flow',
          label: 'Fetch original'
        },
        {
          id: 'e4',
          source: 'images',
          target: 'cache',
          edgeType: 'data-flow',
          label: 'Store variant'
        }
      ]
    )
  },

  // 15. A/B Testing at the Edge
  {
    id: 'ab-testing',
    title: 'A/B Testing at the Edge',
    description:
      'Split traffic server-side on one URL: a Worker reads its assignment config from KV, honours an existing cookie, and routes to the control or variant origin.',
    category: 'Serverless',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/serverless/a-b-testing-using-workers/',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        {
          id: 'splitter',
          x: 250,
          y: 150,
          typeId: 'worker',
          label: 'A/B Worker'
        },
        { id: 'config', x: 500, y: 150, typeId: 'kv', label: 'KV (Config)' },
        {
          id: 'control',
          x: 100,
          y: 300,
          typeId: 'external-api',
          label: 'Control (A)'
        },
        {
          id: 'variant',
          x: 400,
          y: 300,
          typeId: 'external-api',
          label: 'Variant (B)'
        }
      ],
      [
        {
          id: 'e1',
          source: 'client',
          target: 'splitter',
          edgeType: 'data-flow',
          label: 'HTTPS'
        },
        {
          id: 'e2',
          source: 'splitter',
          target: 'config',
          edgeType: 'data-flow',
          label: 'Read assignment'
        },
        {
          id: 'e3',
          source: 'splitter',
          target: 'control',
          edgeType: 'external',
          label: 'Group A'
        },
        {
          id: 'e4',
          source: 'splitter',
          target: 'variant',
          edgeType: 'external',
          label: 'Group B'
        }
      ]
    )
  },

  // 16. Serverless ETL Pipeline
  {
    id: 'serverless-etl',
    title: 'Serverless ETL Pipeline',
    description:
      'Land raw objects in R2, let event notifications drive a Queues consumer that cleans and standardises each batch, then query the curated tables with R2 SQL.',
    category: 'Serverless',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/serverless/serverless-etl/',
    graphData: buildGraphData(
      [
        {
          id: 'producer',
          x: 250,
          y: 0,
          typeId: 'external-api',
          label: 'Data Source'
        },
        { id: 'raw', x: 250, y: 150, typeId: 'r2', label: 'R2 (Raw)' },
        {
          id: 'queue',
          x: 250,
          y: 300,
          typeId: 'queues',
          label: 'Queues (Backlog)'
        },
        {
          id: 'transform',
          x: 250,
          y: 450,
          typeId: 'worker',
          label: 'Transform Consumer'
        },
        {
          id: 'pipeline',
          x: 0,
          y: 600,
          typeId: 'pipelines',
          label: 'Pipelines'
        },
        {
          id: 'catalog',
          x: 250,
          y: 600,
          typeId: 'r2-data-catalog',
          label: 'R2 Data Catalog'
        },
        { id: 'sql', x: 500, y: 600, typeId: 'r2-sql', label: 'R2 SQL' }
      ],
      [
        {
          id: 'e1',
          source: 'producer',
          target: 'raw',
          edgeType: 'external',
          label: 'S3 PUT'
        },
        {
          id: 'e2',
          source: 'raw',
          target: 'queue',
          edgeType: 'trigger',
          label: 'Event notification'
        },
        {
          id: 'e3',
          source: 'queue',
          target: 'transform',
          edgeType: 'trigger',
          label: 'Batch'
        },
        { id: 'e4', source: 'transform', target: 'pipeline', edgeType: 'data-flow' },
        {
          id: 'e5',
          source: 'pipeline',
          target: 'catalog',
          edgeType: 'data-flow',
          label: 'Iceberg tables'
        },
        {
          id: 'e6',
          source: 'sql',
          target: 'catalog',
          edgeType: 'data-flow',
          label: 'Query'
        }
      ]
    )
  },

  // 17. Image Content Management
  {
    id: 'image-content-management',
    title: 'Image Content Management',
    description:
      'Guard an image service with WAF and signature validation, classify uploads with Workers AI for moderation, and keep originals in R2 with metadata in KV.',
    category: 'Serverless',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/serverless/serverless-image-content-management/',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        { id: 'waf', x: 250, y: 150, typeId: 'waf', label: 'WAF / Rate Limiting' },
        {
          id: 'signature',
          x: 250,
          y: 300,
          typeId: 'worker',
          label: 'Signature Validation'
        },
        { id: 'cache', x: 500, y: 300, typeId: 'cdn', label: 'Cache' },
        {
          id: 'images',
          x: 500,
          y: 450,
          typeId: 'images',
          label: 'Image Transformations'
        },
        {
          id: 'moderation',
          x: 0,
          y: 450,
          typeId: 'workers-ai',
          label: 'Image Classification'
        },
        { id: 'store', x: 250, y: 600, typeId: 'r2', label: 'R2 (Images)' },
        { id: 'metadata', x: 0, y: 600, typeId: 'kv', label: 'KV (Metadata)' }
      ],
      [
        { id: 'e1', source: 'client', target: 'waf', edgeType: 'data-flow' },
        { id: 'e2', source: 'waf', target: 'signature', edgeType: 'data-flow' },
        {
          id: 'e3',
          source: 'signature',
          target: 'moderation',
          edgeType: 'data-flow',
          label: 'Classify upload'
        },
        { id: 'e4', source: 'signature', target: 'store', edgeType: 'data-flow' },
        {
          id: 'e5',
          source: 'signature',
          target: 'metadata',
          edgeType: 'data-flow'
        },
        { id: 'e6', source: 'cache', target: 'images', edgeType: 'data-flow' },
        {
          id: 'e7',
          source: 'images',
          target: 'store',
          edgeType: 'data-flow',
          label: 'Fetch original'
        },
        {
          id: 'e8',
          source: 'client',
          target: 'cache',
          edgeType: 'data-flow',
          label: 'GET image'
        }
      ]
    )
  },

  // 18. Egress-Free Multi-Cloud Storage
  {
    id: 'egress-free-multi-cloud',
    title: 'Egress-Free Multi-Cloud Storage',
    description:
      'Keep one R2 bucket reachable from Workers and from external compute over the S3 API, so data-intensive workloads in other clouds read it without egress fees.',
    category: 'Storage',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/storage/egress-free-storage-multi-cloud/',
    graphData: buildGraphData(
      [
        { id: 'worker', x: 0, y: 150, typeId: 'worker', label: 'Worker' },
        { id: 'bucket', x: 250, y: 300, typeId: 'r2', label: 'R2 Bucket' },
        {
          id: 'training',
          x: 500,
          y: 0,
          typeId: 'external-api',
          label: 'Model Training'
        },
        {
          id: 'query-engine',
          x: 500,
          y: 150,
          typeId: 'external-api',
          label: 'Query Engine'
        },
        {
          id: 'on-prem',
          x: 500,
          y: 300,
          typeId: 'external-db',
          label: 'On-Premises'
        }
      ],
      [
        {
          id: 'e1',
          source: 'worker',
          target: 'bucket',
          edgeType: 'data-flow',
          label: 'Workers API'
        },
        {
          id: 'e2',
          source: 'training',
          target: 'bucket',
          edgeType: 'external',
          label: 'S3 API'
        },
        {
          id: 'e3',
          source: 'query-engine',
          target: 'bucket',
          edgeType: 'external',
          label: 'S3 API'
        },
        {
          id: 'e4',
          source: 'on-prem',
          target: 'bucket',
          edgeType: 'external',
          label: 'S3 API'
        }
      ]
    )
  },

  // 19. On-Demand Storage Migration
  {
    id: 'object-storage-migration',
    title: 'On-Demand Storage Migration',
    description:
      'Migrate incrementally with Sippy: serve an object from R2 when present, otherwise fetch it from the source bucket and copy it across on the same request.',
    category: 'Storage',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/storage/on-demand-object-storage-migration/',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        { id: 'worker', x: 250, y: 150, typeId: 'worker', label: 'Object API' },
        { id: 'r2', x: 250, y: 300, typeId: 'r2', label: 'R2 Bucket' },
        {
          id: 'source',
          x: 500,
          y: 300,
          typeId: 'external-api',
          label: 'Source Bucket'
        }
      ],
      [
        {
          id: 'e1',
          source: 'client',
          target: 'worker',
          edgeType: 'data-flow',
          label: 'GET object'
        },
        {
          id: 'e2',
          source: 'worker',
          target: 'r2',
          edgeType: 'data-flow',
          label: 'Hit: serve'
        },
        {
          id: 'e3',
          source: 'r2',
          target: 'source',
          edgeType: 'external',
          label: 'Miss: fetch'
        },
        {
          id: 'e4',
          source: 'source',
          target: 'r2',
          edgeType: 'data-flow',
          label: 'Copy on read'
        }
      ]
    )
  },

  // 20. Storage Event Notifications
  {
    id: 'storage-event-notifications',
    title: 'Storage Event Notifications',
    description:
      'React to bucket changes: R2 event notifications enqueue a message, a push consumer Worker post-processes it, and an external service can pull the same queue over HTTP.',
    category: 'Storage',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/storage/event-notifications-for-storage/',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        { id: 'bucket', x: 250, y: 150, typeId: 'r2', label: 'R2 Bucket' },
        { id: 'queue', x: 250, y: 300, typeId: 'queues', label: 'Queue' },
        {
          id: 'consumer',
          x: 0,
          y: 450,
          typeId: 'worker',
          label: 'Consumer Worker'
        },
        { id: 'logs', x: 0, y: 600, typeId: 'r2', label: 'R2 (Event Log)' },
        {
          id: 'external',
          x: 500,
          y: 450,
          typeId: 'external-api',
          label: 'Pull Consumer'
        }
      ],
      [
        {
          id: 'e1',
          source: 'client',
          target: 'bucket',
          edgeType: 'data-flow',
          label: 'Upload / delete'
        },
        {
          id: 'e2',
          source: 'bucket',
          target: 'queue',
          edgeType: 'trigger',
          label: 'Event notification'
        },
        {
          id: 'e3',
          source: 'queue',
          target: 'consumer',
          edgeType: 'trigger',
          label: 'Push'
        },
        { id: 'e4', source: 'consumer', target: 'logs', edgeType: 'data-flow' },
        {
          id: 'e5',
          source: 'external',
          target: 'queue',
          edgeType: 'external',
          label: 'HTTP pull'
        }
      ]
    )
  },

  // 21. User-Generated Content
  {
    id: 'user-generated-content',
    title: 'User-Generated Content',
    description:
      'Let a Worker authorise an upload and hand back a signed URL so the file streams straight to R2, with event notifications driving metadata writes into D1.',
    category: 'Storage',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/storage/storing-user-generated-content/',
    graphData: buildGraphData(
      [
        {
          id: 'client',
          x: 250,
          y: 0,
          typeId: 'client-browser',
          label: 'Client (Browser)'
        },
        {
          id: 'auth-worker',
          x: 250,
          y: 150,
          typeId: 'worker',
          label: 'Upload Authoriser'
        },
        { id: 'access', x: 0, y: 150, typeId: 'access', label: 'Access' },
        { id: 'bucket', x: 250, y: 300, typeId: 'r2', label: 'R2 (Uploads)' },
        { id: 'queue', x: 500, y: 300, typeId: 'queues', label: 'Queue' },
        {
          id: 'post-process',
          x: 500,
          y: 450,
          typeId: 'worker',
          label: 'Post-Processing'
        },
        { id: 'metadata', x: 250, y: 450, typeId: 'd1', label: 'D1 (Metadata)' }
      ],
      [
        {
          id: 'e1',
          source: 'client',
          target: 'auth-worker',
          edgeType: 'data-flow',
          label: 'Request upload'
        },
        { id: 'e2', source: 'auth-worker', target: 'access', edgeType: 'data-flow' },
        {
          id: 'e3',
          source: 'client',
          target: 'bucket',
          edgeType: 'data-flow',
          label: 'Signed PUT'
        },
        {
          id: 'e4',
          source: 'bucket',
          target: 'queue',
          edgeType: 'trigger',
          label: 'Event notification'
        },
        { id: 'e5', source: 'queue', target: 'post-process', edgeType: 'trigger' },
        {
          id: 'e6',
          source: 'post-process',
          target: 'metadata',
          edgeType: 'data-flow'
        }
      ]
    )
  },

  // 22. Control and Data Plane
  {
    id: 'durable-object-control-data-plane',
    title: 'Control and Data Plane',
    description:
      'Shard per resource: one control-plane Durable Object owns creation and listing, while each resource gets its own data-plane object addressed directly for reads and writes.',
    category: 'Storage',
    referenceUrl:
      'https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/',
    graphData: buildGraphData(
      [
        {
          id: 'user-lhr',
          x: 0,
          y: 0,
          typeId: 'client-browser',
          label: 'User (LHR)'
        },
        {
          id: 'user-pdx',
          x: 500,
          y: 0,
          typeId: 'client-browser',
          label: 'User (PDX)'
        },
        { id: 'api', x: 250, y: 150, typeId: 'worker', label: 'API Worker' },
        {
          id: 'control',
          x: 250,
          y: 300,
          typeId: 'durable-object',
          label: 'Control Plane DO'
        },
        {
          id: 'data-1',
          x: 0,
          y: 450,
          typeId: 'durable-object',
          label: 'Data Plane DO 01'
        },
        {
          id: 'data-3',
          x: 500,
          y: 450,
          typeId: 'durable-object',
          label: 'Data Plane DO 03'
        }
      ],
      [
        {
          id: 'e1',
          source: 'user-lhr',
          target: 'api',
          edgeType: 'data-flow',
          label: 'Create'
        },
        {
          id: 'e2',
          source: 'api',
          target: 'control',
          edgeType: 'data-flow',
          label: 'idFromName'
        },
        {
          id: 'e3',
          source: 'control',
          target: 'data-3',
          edgeType: 'trigger',
          label: 'Create + init'
        },
        {
          id: 'e4',
          source: 'api',
          target: 'data-3',
          edgeType: 'data-flow',
          label: 'Write'
        },
        {
          id: 'e5',
          source: 'user-pdx',
          target: 'api',
          edgeType: 'data-flow',
          label: 'Read'
        },
        {
          id: 'e6',
          source: 'api',
          target: 'data-1',
          edgeType: 'data-flow',
          label: 'Direct read'
        }
      ]
    )
  }
];

/**
 * Lookup map from blueprint ID to its definition.
 */
export const BLUEPRINT_MAP = new Map(BLUEPRINTS.map((b) => [b.id, b]));
