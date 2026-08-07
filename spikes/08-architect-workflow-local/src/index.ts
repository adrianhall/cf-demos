import { ArchitectureWorkflow } from "./architecture-workflow";
import type { ArchitectureJobInput, GeneratorFixture } from "./contracts";
import { DiagramRoom } from "./diagram-room";

export { ArchitectureWorkflow, DiagramRoom };

/** Starts a deterministic local Workflow job and exposes status for local command-line probing. */
export default {
  /**
   * Creates or returns a Workflow instance for a caller-selected deterministic fixture.
   *
   * @param request HTTP request carrying job fields as JSON.
   * @param env Local D1, R2, Durable Object, and Workflow bindings.
   * @returns JSON describing the created or existing idempotent job.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/jobs") return new Response("POST /jobs", { status: 404 });
    const input = await request.json<ArchitectureJobInput>();
    if (!isInput(input)) return Response.json({ error: "invalid job input" }, { status: 400 });
    const insert = await env.ARCHITECT_DB.prepare("INSERT OR IGNORE INTO architecture_jobs (id, diagram_id, base_revision, fixture, status) VALUES (?, ?, ?, ?, 'queued')")
      .bind(input.jobId, input.diagramId, input.baseRevision, input.fixture)
      .run();
    if (insert.meta.changes === 0) return Response.json({ id: input.jobId, duplicate: true }, { status: 200 });
    await env.ARCHITECTURE_WORKFLOW.create({ id: input.jobId, params: input });
    return Response.json({ id: input.jobId, duplicate: false }, { status: 202 });
  },
};

/** Validates the small local HTTP input contract before any D1 write. */
function isInput(value: ArchitectureJobInput): value is ArchitectureJobInput {
  const fixtures: GeneratorFixture[] = ["valid", "malformed", "transient", "exhausted", "unknown-product", "invalid-edge"];
  return typeof value?.jobId === "string" && typeof value.diagramId === "string" && Number.isInteger(value.baseRevision) && fixtures.includes(value.fixture);
}
