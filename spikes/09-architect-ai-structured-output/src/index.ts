/** A fixed, deployed Workers AI structured-output probe with no prompt-bearing public API. */

/** A product node proposed by the architecture model. */
interface ArchitectureNode {
  id: string;
  product: string;
}

/** A directed connection between proposed architecture nodes. */
interface ArchitectureEdge {
  from: string;
  to: string;
  kind: "http" | "event" | "storage";
}

/** The small renderer-independent architecture proposal contract. */
interface ArchitectureProposal {
  title: string;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
}

/** A committed prompt fixture that can be selected without accepting arbitrary prompt text. */
interface Fixture {
  id: "small" | "medium" | "invalid";
  request: string;
}

/** The response format candidate sent to the model binding. */
type Adapter = "response_format" | "guided_json";

/** The schema sent to Workers AI and used as the authoritative local validation contract. */
const architectureSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 80 },
    nodes: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
          product: { type: "string", enum: ["workers", "d1", "r2", "kv", "queues"] }
        },
        required: ["id", "product"]
      }
    },
    edges: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          kind: { type: "string", enum: ["http", "event", "storage"] }
        },
        required: ["from", "to", "kind"]
      }
    }
  },
  required: ["title", "nodes", "edges"]
} as const;

const fixtures: readonly Fixture[] = [
  { id: "small", request: "Propose a minimal public API with durable relational data." },
  { id: "medium", request: "Propose an image-processing service with API, object storage, asynchronous work, and a metadata store." },
  { id: "invalid", request: "Deliberately propose one product that is not in the allowed catalog so validation can reject it." }
];

/** Finds a committed fixture without exposing fixture text to the HTTP caller. */
function fixtureFor(id: unknown): Fixture | undefined {
  return typeof id === "string" ? fixtures.find((fixture) => fixture.id === id) : undefined;
}

/** Returns a non-sensitive description of an unknown response's top-level shape. */
function shapeOf(value: unknown): { kind: string; topLevelKeys: string[] } {
  if (value === null) return { kind: "null", topLevelKeys: [] };
  if (Array.isArray(value)) return { kind: "array", topLevelKeys: [] };
  if (typeof value !== "object") return { kind: typeof value, topLevelKeys: [] };
  return { kind: "object", topLevelKeys: Object.keys(value).sort().slice(0, 12) };
}

/** Extracts the structured payload from the documented Workers AI response wrapper. */
function payloadFrom(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("response" in value)) return undefined;
  return value.response;
}

/** Validates the proposal independently from JSON Mode, including catalog and edge integrity. */
function validateProposal(value: unknown): { valid: boolean; code: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { valid: false, code: "not-object" };
  const proposal = value as Partial<ArchitectureProposal>;
  if (typeof proposal.title !== "string" || proposal.title.length === 0 || proposal.title.length > 80) return { valid: false, code: "title" };
  if (!Array.isArray(proposal.nodes) || proposal.nodes.length < 2 || proposal.nodes.length > 8) return { valid: false, code: "nodes" };
  const ids = new Set<string>();
  for (const node of proposal.nodes) {
    if (!node || typeof node.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(node.id) || ids.has(node.id)) return { valid: false, code: "node-id" };
    if (!node.product || !["workers", "d1", "r2", "kv", "queues"].includes(node.product)) return { valid: false, code: "unknown-product" };
    ids.add(node.id);
  }
  if (!Array.isArray(proposal.edges) || proposal.edges.length > 10) return { valid: false, code: "edges" };
  for (const edge of proposal.edges) {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || !["http", "event", "storage"].includes(edge.kind)) return { valid: false, code: "invalid-edge" };
  }
  return { valid: true, code: "valid" };
}

/** Calls one safe structured-output candidate and returns metadata without model content. */
async function probeAdapter(env: Env, fixture: Fixture, adapter: Adapter): Promise<Record<string, unknown>> {
  const request = {
    messages: [
      { role: "system", content: "Return only an architecture proposal using the supplied schema. Allowed products: workers, d1, r2, kv, queues. Use only allowed products unless explicitly asked to test rejection." },
      { role: "user", content: fixture.request }
    ],
    max_tokens: 600,
    temperature: 0,
    ...(adapter === "response_format"
      ? { response_format: { type: "json_schema", json_schema: architectureSchema } }
      : { guided_json: architectureSchema })
  };
  const startedAt = Date.now();
  try {
    const raw = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", request as never);
    const payload = payloadFrom(raw);
    const validation = validateProposal(payload);
    return {
      adapter,
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      accepted: true,
      elapsedMs: Date.now() - startedAt,
      responseShape: shapeOf(raw),
      payloadShape: shapeOf(payload),
      validation
    };
  } catch {
    return {
      adapter,
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      accepted: false,
      elapsedMs: Date.now() - startedAt,
      failure: "binding-or-model-rejected-request"
    };
  }
}

export default {
  /** Runs only the selected committed fixture through safe adapter candidates. */
  async fetch(request, env): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/probe") {
      return new Response("Not found", { status: 404 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid-request" }, { status: 400 });
    }
    const fixture = fixtureFor(typeof body === "object" && body !== null ? (body as { fixture?: unknown }).fixture : undefined);
    if (!fixture) return Response.json({ error: "unknown-fixture" }, { status: 400 });
    const results = await Promise.all([probeAdapter(env, fixture, "response_format"), probeAdapter(env, fixture, "guided_json")]);
    return Response.json(
      { fixture: fixture.id, schemaBytes: JSON.stringify(architectureSchema).length, results },
      { headers: { "x-spike-worker": "09" } }
    );
  }
} satisfies ExportedHandler<Env>;
