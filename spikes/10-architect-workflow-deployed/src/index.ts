import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

/** The two committed inputs accepted by the narrow HTTP probe. */
type Fixture = "successful" | "invalid";

/** Parameters persisted with a Workflow instance. */
interface ArchitectureJobParameters {
  /** D1 primary key and deterministic Durable Object name. */
  jobId: string;
  /** Fixed fixture selected by the HTTP probe. */
  fixture: Fixture;
}

/** The durable job states exposed by `GET /jobs/:id`. */
type JobStatus = "queued" | "summarizing" | "generating" | "validating" | "storing" | "ready" | "failed";

/** Last state notification retained by the per-job Durable Object. */
interface JobNotification {
  /** Job whose state changed. */
  jobId: string;
  /** State written to D1 before this notification. */
  status: JobStatus;
  /** ISO-8601 transition time. */
  updatedAt: string;
}

/** Minimal persisted proposal accepted by this spike's catalog validator. */
interface Proposal {
  /** Curated Cloudflare products selected by the generator. */
  products: string[];
  /** Directed relationships between selected products. */
  edges: [string, string][];
}

const FIXTURES: readonly Fixture[] = ["successful", "invalid"];
const CATALOG = new Set(["Workers", "D1", "R2"]);

/** Returns an ISO timestamp without retaining request-scoped state. */
function now(): string {
  return new Date().toISOString();
}

/** Narrows a value to an object with string keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validates the intentionally small architecture contract.
 *
 * @param value Candidate model output.
 * @returns A proposal safe to write to R2.
 * @throws Error when a product or edge is outside the curated catalog.
 */
function validateProposal(value: unknown): Proposal {
  if (!isRecord(value) || !Array.isArray(value.products) || !Array.isArray(value.edges)) {
    throw new Error("proposal does not contain products and edges arrays");
  }
  const products = value.products;
  const edges = value.edges;
  if (!products.every((product): product is string => typeof product === "string" && CATALOG.has(product))) {
    throw new Error("proposal contains an unknown product");
  }
  if (!edges.every((edge): edge is [string, string] => Array.isArray(edge) && edge.length === 2 && edge.every((product) => typeof product === "string" && products.includes(product)))) {
    throw new Error("proposal contains an invalid edge");
  }
  return { products, edges };
}

/**
 * Extracts the textual response returned by the Workers AI binding.
 *
 * @param response Raw model response.
 * @returns Parsed JSON candidate.
 * @throws Error when the binding does not return a JSON response string.
 */
function parseModelProposal(response: unknown): unknown {
  if (!isRecord(response) || typeof response.response !== "string") {
    throw new Error("Workers AI response did not contain a response string");
  }
  return JSON.parse(response.response.replace(/^```json\s*|\s*```$/g, ""));
}

/** Records a notification durably so HTTP can prove the Workflow-to-DO path. */
export class JobNotifications extends DurableObject<Env> {
  /**
   * Stores the most recent D1-confirmed state transition.
   *
   * @param notification Transition to retain.
   * @returns A promise resolved after durable storage completes.
   */
  async record(notification: JobNotification): Promise<void> {
    await this.ctx.storage.put("last-notification", notification);
  }

  /**
   * Reads the latest notification for the HTTP probe.
   *
   * @returns The retained transition, or `null` before a Workflow starts.
   */
  async last(): Promise<JobNotification | null> {
    return (await this.ctx.storage.get<JobNotification>("last-notification")) ?? null;
  }
}

/** Runs one architecture job across D1, Workers AI, R2, and a Durable Object. */
export class ArchitectureWorkflow extends WorkflowEntrypoint<Env, ArchitectureJobParameters> {
  /**
   * Writes D1 before notifying the Durable Object, making each reported notification attributable
   * to a durable job state.
   *
   * @param jobId Job being transitioned.
   * @param status New state.
   * @param failureReason Optional terminal failure reason.
   * @returns A promise resolved after D1 and Durable Object writes complete.
   */
  async transition(jobId: string, status: JobStatus, failureReason: string | null = null): Promise<void> {
    const updatedAt = now();
    await this.env.DB.prepare(
      "UPDATE architecture_jobs SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?",
    )
      .bind(status, failureReason, updatedAt, jobId)
      .run();
    await this.env.JOB_NOTIFICATIONS.getByName(jobId).record({ jobId, status, updatedAt });
  }

  /**
   * Executes the committed fixture and finalizes every terminal failure in D1 and the DO.
   *
   * @param event Workflow event containing a job ID and fixture.
   * @param step Durable Workflows step API.
   * @returns The final job status.
   */
  async run(event: WorkflowEvent<ArchitectureJobParameters>, step: WorkflowStep): Promise<JobStatus> {
    const { fixture, jobId } = event.payload;
    try {
      await this.transition(jobId, "summarizing");
      await step.do("summarize", async () => ({ catalog: [...CATALOG], fixture }));

      await this.transition(jobId, "generating");
      const generated = await step.do(
        "generate",
        { retries: { limit: 2, delay: "1 second", backoff: "exponential" } },
        async () => {
          if (fixture === "invalid") {
            return JSON.stringify({ products: ["Unknown Product"], edges: [] });
          }
          const response = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
            prompt: "Return only valid JSON: {\"products\":[\"Workers\",\"D1\",\"R2\"],\"edges\":[[\"Workers\",\"D1\"],[\"Workers\",\"R2\"]]}. Do not add markdown or prose.",
          });
          return JSON.stringify(response);
        },
      );

      await this.transition(jobId, "validating");
      const proposal = validateProposal(fixture === "invalid" ? JSON.parse(generated) : parseModelProposal(JSON.parse(generated)));

      await this.transition(jobId, "storing");
      const proposalKey = `proposals/${jobId}.json`;
      await step.do("store", async () => {
        await this.env.PROPOSALS.put(proposalKey, JSON.stringify(proposal), {
          httpMetadata: { contentType: "application/json" },
        });
      });
      await this.env.DB.prepare("UPDATE architecture_jobs SET proposal_key = ? WHERE id = ?")
        .bind(proposalKey, jobId)
        .run();
      await this.transition(jobId, "ready");
      return "ready";
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : "unknown workflow failure";
      await this.transition(jobId, "failed", failureReason);
      return "failed";
    }
  }
}

/** Reads and validates the fixed fixture body accepted by POST /jobs. */
async function readFixture(request: Request): Promise<Fixture | null> {
  if (request.headers.get("content-type") !== "application/json") {
    return null;
  }
  const body: unknown = await request.json();
  if (!isRecord(body) || typeof body.fixture !== "string" || !FIXTURES.includes(body.fixture as Fixture)) {
    return null;
  }
  return body.fixture as Fixture;
}

/** Implements the deliberately narrow deployed HTTP probe surface. */
export default {
  /**
   * Starts a committed fixture or reads D1 plus the corresponding Durable Object notification.
   *
   * @param request Incoming HTTP request.
   * @param env Worker bindings generated from Wrangler configuration.
   * @returns A response for the two allowed probe routes.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/jobs") {
      const fixture = await readFixture(request);
      if (fixture === null) {
        return Response.json({ error: "fixture must be successful or invalid" }, { status: 400 });
      }
      const jobId = crypto.randomUUID();
      const createdAt = now();
      await env.DB.prepare(
        "INSERT INTO architecture_jobs (id, fixture, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)",
      )
        .bind(jobId, fixture, createdAt, createdAt)
        .run();
      await env.ARCHITECTURE_WORKFLOW.create({ id: jobId, params: { jobId, fixture } });
      return Response.json({ id: jobId, status: "queued" }, { status: 202 });
    }

    const match = /^\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (request.method === "GET" && match !== null) {
      const job = await env.DB.prepare(
        "SELECT id, fixture, status, proposal_key AS proposalKey, failure_reason AS failureReason, created_at AS createdAt, updated_at AS updatedAt FROM architecture_jobs WHERE id = ?",
      )
        .bind(match[1])
        .first<Record<string, unknown>>();
      if (job === null) {
        return Response.json({ error: "job not found" }, { status: 404 });
      }
      try {
        const notification = await env.JOB_NOTIFICATIONS.getByName(match[1]).last();
        return Response.json({ job, notification });
      } catch (error) {
        console.error("job status read failed", error);
        return Response.json(
          { error: "job status read failed", detail: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }
    return new Response("Not found", { status: 404 });
  },
};
