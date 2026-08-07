/**
 * @file Phase 5 integration coverage: the Workflow-backed AI architecture proposal feature, end
 * to end, against real D1, R2, and Durable Object bindings.
 *
 * Every test drives generation through {@link fixturePrompt} — `ArchitectureWorkflow`'s
 * generator factory (`../../src/worker/architecture/generator.ts`) selects the deterministic
 * `FixtureArchitectureGenerator` whenever `env.ENVIRONMENT === "test"`
 * (`./vitest.config.ts` sets exactly that binding), so no test in this file ever calls the real
 * `AI` binding — matching Spike 08's own restriction and `docs/09-ARCHITECT.md`'s Phase 5 testing
 * guidance.
 *
 * A test that opens a real WebSocket to observe `job_progress` frames follows the
 * `testing-durable-objects` skill's cleanup recipe: tracked sockets are closed best-effort
 * (never awaited) and `evictAllDurableObjects({ webSockets: "close" })` runs in `afterEach`.
 */
import { applyD1Migrations, evictAllDurableObjects } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixturePrompt } from "../../src/worker/architecture/fixtures";

/** Bind the generated Worker configuration to the Workers integration runtime. */
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

/** Test-only D1 migrations binding injected by `./vitest.config.ts`. */
interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/** A diagram, as returned by the diagrams API. */
interface DiagramResponse {
  id: string;
  ownerEmail: string;
  title: string;
}

/** An `architecture_jobs` row, as returned by the proposal start/status API. */
interface ArchitectureJobResponse {
  id: string;
  diagramId: string;
  baseRevision: number;
  requesterEmail: string;
  status: string;
  proposalR2Key: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Raw snake-cased `architecture_jobs` row, as read directly from D1 for assertions. */
interface ArchitectureJobRow {
  status: string;
  proposal_r2_key: string | null;
  workflow_instance_id: string;
}

/** Build and send an authenticated request against the real Worker, matching production shape. */
async function authenticatedRequest(
  path: string,
  options: {
    body?: unknown;
    email?: string;
    method?: string;
    origin?: string | null;
  } = {},
): Promise<Response> {
  const {
    body,
    email = "owner@example.com",
    method = "GET",
    origin = "http://example.test",
  } = options;
  const token = await signDevJwt(email);
  const headers = new Headers({ [JWT_HEADER]: token });
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD" && origin !== null) {
    headers.set("origin", origin);
  }
  return exports.default.fetch(
    new Request(`http://example.test${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
      method,
    }),
  );
}

/** Create a diagram (seeded at revision 1 by its starter blueprint) and return its directory record. */
async function createDiagram(
  title: string,
  email: string,
): Promise<DiagramResponse> {
  const response = await authenticatedRequest("/api/diagrams", {
    body: { title },
    email,
    method: "POST",
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { diagram: DiagramResponse };
  return body.diagram;
}

/** Start a proposal job through the real HTTP route. */
async function startProposal(
  diagramId: string,
  email: string,
  prompt: string,
  idempotencyKey?: string,
): Promise<Response> {
  return authenticatedRequest(`/api/diagrams/${diagramId}/proposals`, {
    body: idempotencyKey ? { prompt, idempotencyKey } : { prompt },
    email,
    method: "POST",
  });
}

/** Poll D1 directly until a job reaches a terminal status, or throw after `timeoutMs`. */
async function waitForTerminal(
  jobId: string,
  timeoutMs = 10_000,
): Promise<ArchitectureJobRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await env.DB.prepare(
      "SELECT status, proposal_r2_key, workflow_instance_id FROM architecture_jobs WHERE id = ?",
    )
      .bind(jobId)
      .first<ArchitectureJobRow>();
    if (row && (row.status === "ready" || row.status === "failed")) {
      return row;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Job ${jobId} did not reach a terminal status within ${timeoutMs}ms (last seen: ${row?.status})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("Phase 5 Workflow-backed AI architecture proposals", () => {
  const openSockets = new Set<WebSocket>();

  beforeAll(async () => {
    const testEnv = env as TestEnv;
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    for (const socket of openSockets) {
      if (
        socket.readyState !== WebSocket.CLOSED &&
        socket.readyState !== WebSocket.CLOSING
      ) {
        socket.close();
      }
    }
    openSockets.clear();
    await evictAllDurableObjects({ webSockets: "close" });
  });

  it("reaches ready with a validated R2 proposal and a durable D1 row for a valid fixture", async () => {
    const diagram = await createDiagram(
      "AI valid test",
      "owner-ai1@example.com",
    );
    const response = await startProposal(
      diagram.id,
      "owner-ai1@example.com",
      fixturePrompt("valid"),
    );
    expect(response.status).toBe(201);
    const { job, duplicate } = (await response.json()) as {
      job: ArchitectureJobResponse;
      duplicate: boolean;
    };
    expect(duplicate).toBe(false);
    expect(job.diagramId).toBe(diagram.id);

    const row = await waitForTerminal(job.id);
    expect(row.status).toBe("ready");
    expect(row.workflow_instance_id).toBe(job.id);
    expect(row.proposal_r2_key).toBe(`proposals/${job.id}.json`);

    const object = await env.SNAPSHOTS.get(row.proposal_r2_key as string);
    expect(object).not.toBeNull();
    const document = JSON.parse(await (object as R2ObjectBody).text()) as {
      nodes: Array<{ id: string }>;
      edges: unknown[];
    };
    expect(document.nodes.map((node) => node.id)).toEqual(["client", "api"]);
  });

  it("reaches durable failed for malformed model output", async () => {
    const diagram = await createDiagram(
      "AI malformed test",
      "owner-ai2@example.com",
    );
    const response = await startProposal(
      diagram.id,
      "owner-ai2@example.com",
      fixturePrompt("malformed"),
    );
    const { job } = (await response.json()) as { job: ArchitectureJobResponse };

    const row = await waitForTerminal(job.id);
    expect(row.status).toBe("failed");
    expect(row.proposal_r2_key).toBeNull();
  });

  it("reaches durable failed for an unknown catalog product", async () => {
    const diagram = await createDiagram(
      "AI unknown product test",
      "owner-ai3@example.com",
    );
    const response = await startProposal(
      diagram.id,
      "owner-ai3@example.com",
      fixturePrompt("unknown-product"),
    );
    const { job } = (await response.json()) as { job: ArchitectureJobResponse };

    const row = await waitForTerminal(job.id);
    expect(row.status).toBe("failed");
  });

  it("reaches durable failed for an edge with a dangling endpoint", async () => {
    const diagram = await createDiagram(
      "AI invalid edge test",
      "owner-ai4@example.com",
    );
    const response = await startProposal(
      diagram.id,
      "owner-ai4@example.com",
      fixturePrompt("invalid-edge"),
    );
    const { job } = (await response.json()) as { job: ArchitectureJobResponse };

    const row = await waitForTerminal(job.id);
    expect(row.status).toBe("failed");
  });

  it("retries the generate step once and reaches ready after one transient failure", async () => {
    const diagram = await createDiagram(
      "AI transient test",
      "owner-ai5@example.com",
    );
    const response = await startProposal(
      diagram.id,
      "owner-ai5@example.com",
      fixturePrompt("transient-then-success"),
    );
    const { job } = (await response.json()) as { job: ArchitectureJobResponse };

    const row = await waitForTerminal(job.id);
    expect(row.status).toBe("ready");
    expect(row.proposal_r2_key).toBe(`proposals/${job.id}.json`);
  });

  it("reaches durable failed after the generate step exhausts its one configured retry", async () => {
    const diagram = await createDiagram(
      "AI exhausted test",
      "owner-ai6@example.com",
    );
    const response = await startProposal(
      diagram.id,
      "owner-ai6@example.com",
      fixturePrompt("exhausted"),
    );
    const { job } = (await response.json()) as { job: ArchitectureJobResponse };

    const row = await waitForTerminal(job.id);
    expect(row.status).toBe("failed");
  });

  it("does not create a second job or Workflow instance for a duplicate idempotency key", async () => {
    const diagram = await createDiagram(
      "AI idempotency test",
      "owner-ai7@example.com",
    );
    const first = await startProposal(
      diagram.id,
      "owner-ai7@example.com",
      fixturePrompt("valid"),
      "retry-key-1",
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      job: ArchitectureJobResponse;
      duplicate: boolean;
    };
    expect(firstBody.duplicate).toBe(false);

    const second = await startProposal(
      diagram.id,
      "owner-ai7@example.com",
      fixturePrompt("valid"),
      "retry-key-1",
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      job: ArchitectureJobResponse;
      duplicate: boolean;
    };
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.job.id).toBe(firstBody.job.id);

    await waitForTerminal(firstBody.job.id);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM architecture_jobs WHERE diagram_id = ?",
    )
      .bind(diagram.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("broadcasts job_progress frames, in order, to every connected socket", async () => {
    const diagram = await createDiagram(
      "AI broadcast test",
      "owner-ai8@example.com",
    );

    async function openSocket(email: string): Promise<WebSocket> {
      const token = await signDevJwt(email);
      const response = await exports.default.fetch(
        new Request(`http://example.test/api/diagrams/${diagram.id}/ws`, {
          headers: {
            [JWT_HEADER]: token,
            Origin: "http://example.test",
            Upgrade: "websocket",
          },
        }),
      );
      if (!response.webSocket) {
        throw new Error("Expected a WebSocket upgrade.");
      }
      const socket = response.webSocket;
      openSockets.add(socket);
      socket.accept();
      return socket;
    }

    const socketA = await openSocket("owner-ai8@example.com");
    const socketB = await openSocket("owner-ai8@example.com");

    // Register both listeners before starting the job so neither can miss an early frame.
    const jobIdPromise = startProposal(
      diagram.id,
      "owner-ai8@example.com",
      fixturePrompt("valid"),
    ).then(async (response) => {
      const body = (await response.json()) as { job: ArchitectureJobResponse };
      return body.job.id;
    });

    // We need the job id before we can filter frames by it, but must have already registered
    // interest in "any job_progress frame" before that id is known — collect all job_progress
    // frames on both sockets, then filter/derive order once the id is known.
    const framesA: Array<{ jobId: string; status: string }> = [];
    const framesB: Array<{ jobId: string; status: string }> = [];
    function record(
      socket: WebSocket,
      sink: Array<{ jobId: string; status: string }>,
    ): void {
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as {
          type: string;
          jobId?: string;
          status?: string;
        };
        if (frame.type === "job_progress") {
          sink.push({
            jobId: frame.jobId as string,
            status: frame.status as string,
          });
        }
      });
    }
    record(socketA, framesA);
    record(socketB, framesB);

    const jobId = await jobIdPromise;
    await waitForTerminal(jobId);
    // Give any already-in-flight broadcasts a moment to be delivered to both sockets.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const statusesA = framesA
      .filter((frame) => frame.jobId === jobId)
      .map((frame) => frame.status);
    const statusesB = framesB
      .filter((frame) => frame.jobId === jobId)
      .map((frame) => frame.status);

    expect(statusesA).toEqual(statusesB);
    expect(statusesA[0]).toBe("summarizing");
    expect(statusesA.at(-1)).toBe("ready");
    expect(statusesA).toEqual([
      "summarizing",
      "generating",
      "validating",
      "storing",
      "ready",
    ]);
  });

  it("applies an accepted proposal as one atomic replace_document revision", async () => {
    const diagram = await createDiagram(
      "AI accept test",
      "owner-ai9@example.com",
    );
    const started = await startProposal(
      diagram.id,
      "owner-ai9@example.com",
      fixturePrompt("valid"),
    );
    const { job } = (await started.json()) as { job: ArchitectureJobResponse };
    await waitForTerminal(job.id);

    const acceptResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/proposals/${job.id}/accept`,
      { body: {}, email: "owner-ai9@example.com", method: "POST" },
    );
    expect(acceptResponse.status).toBe(200);
    const { result } = (await acceptResponse.json()) as {
      result: { status: string; revision: number };
    };
    expect(result.status).toBe("accepted");
    expect(result.revision).toBe(job.baseRevision + 1);

    const opened = await authenticatedRequest(`/api/diagrams/${diagram.id}`, {
      email: "owner-ai9@example.com",
    });
    const openedBody = (await opened.json()) as {
      document: { nodes: Array<{ id: string }> };
    };
    expect(openedBody.document.nodes.map((node) => node.id)).toEqual([
      "client",
      "api",
    ]);
  });

  it("rejects acceptance with a specific reason when the diagram changed since the job's base revision", async () => {
    const diagram = await createDiagram(
      "AI stale accept test",
      "owner-ai10@example.com",
    );
    const started = await startProposal(
      diagram.id,
      "owner-ai10@example.com",
      fixturePrompt("valid"),
    );
    const { job } = (await started.json()) as { job: ArchitectureJobResponse };
    await waitForTerminal(job.id);

    // Someone edits the diagram after the job captured its base revision.
    const editResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/operations`,
      {
        body: {
          operationId: "concurrent-edit",
          baseRevision: job.baseRevision,
          kind: "add_node",
          payload: {
            node: {
              id: "concurrent-node",
              type: "actor",
              position: { x: 0, y: 0 },
              data: { kind: "external-actor", label: "Concurrent" },
            },
          },
        },
        email: "owner-ai10@example.com",
        method: "POST",
      },
    );
    expect(editResponse.status).toBe(200);

    const acceptResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/proposals/${job.id}/accept`,
      { body: {}, email: "owner-ai10@example.com", method: "POST" },
    );
    expect(acceptResponse.status).toBe(422);
    const problem = (await acceptResponse.json()) as { reason?: string };
    expect(problem.reason).toBe("stale_base_revision");
  });

  it("enforces one active job per diagram", async () => {
    const diagram = await createDiagram(
      "AI single active job test",
      "owner-ai11@example.com",
    );
    const first = await startProposal(
      diagram.id,
      "owner-ai11@example.com",
      fixturePrompt("valid"),
    );
    expect(first.status).toBe(201);

    const second = await startProposal(
      diagram.id,
      "owner-ai11@example.com",
      fixturePrompt("valid"),
    );
    expect(second.status).toBe(409);
  });

  it("throttles a second proposal start from the same requester across diagrams", async () => {
    const diagramA = await createDiagram(
      "AI rate limit A",
      "owner-ai12@example.com",
    );
    const diagramB = await createDiagram(
      "AI rate limit B",
      "owner-ai12@example.com",
    );

    const first = await startProposal(
      diagramA.id,
      "owner-ai12@example.com",
      fixturePrompt("valid"),
    );
    expect(first.status).toBe(201);

    const second = await startProposal(
      diagramB.id,
      "owner-ai12@example.com",
      fixturePrompt("valid"),
    );
    expect(second.status).toBe(429);
  });

  it("lets the Workflow bootstrap its own D1 row when triggered directly, with no pre-existing job row", async () => {
    const diagram = await createDiagram(
      "AI standalone trigger test",
      "standalone@example.com",
    );
    const jobId = crypto.randomUUID();

    // Deliberately no architecture_jobs row is inserted here — this is the point of the test:
    // the Workflow's own `summarize` step must create it via INSERT OR IGNORE.
    await env.ARCHITECTURE_WORKFLOW.create({
      id: jobId,
      params: {
        diagramId: diagram.id,
        baseRevision: 1,
        requesterEmail: "standalone@example.com",
        prompt: fixturePrompt("valid"),
      },
    });

    const row = await waitForTerminal(jobId);
    expect(row.status).toBe("ready");
    expect(row.proposal_r2_key).toBe(`proposals/${jobId}.json`);
  });

  it("GET status combines the D1 job, the room's last notification, and the proposal once ready", async () => {
    const diagram = await createDiagram(
      "AI status route test",
      "owner-ai13@example.com",
    );
    const started = await startProposal(
      diagram.id,
      "owner-ai13@example.com",
      fixturePrompt("valid"),
    );
    const { job } = (await started.json()) as { job: ArchitectureJobResponse };
    await waitForTerminal(job.id);

    const statusResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/proposals/${job.id}`,
      { email: "owner-ai13@example.com" },
    );
    expect(statusResponse.status).toBe(200);
    const body = (await statusResponse.json()) as {
      job: ArchitectureJobResponse;
      notification: { status: string } | null;
      proposal?: { nodes: Array<{ id: string }> };
    };
    expect(body.job.status).toBe("ready");
    expect(body.notification).toMatchObject({ status: "ready" });
    expect(body.proposal?.nodes.map((node) => node.id)).toEqual([
      "client",
      "api",
    ]);
  });

  it("GET status returns 404 for a job id that does not belong to the requested diagram", async () => {
    const diagramA = await createDiagram(
      "AI status A",
      "owner-ai14@example.com",
    );
    const diagramB = await createDiagram(
      "AI status B",
      "owner-ai14@example.com",
    );
    const started = await startProposal(
      diagramA.id,
      "owner-ai14@example.com",
      fixturePrompt("valid"),
    );
    const { job } = (await started.json()) as { job: ArchitectureJobResponse };

    const response = await authenticatedRequest(
      `/api/diagrams/${diagramB.id}/proposals/${job.id}`,
      { email: "owner-ai14@example.com" },
    );
    expect(response.status).toBe(404);
  });

  it("rejects accepting a job that has not reached ready", async () => {
    const diagram = await createDiagram(
      "AI accept not ready test",
      "owner-ai15@example.com",
    );
    const started = await startProposal(
      diagram.id,
      "owner-ai15@example.com",
      fixturePrompt("exhausted"),
    );
    const { job } = (await started.json()) as { job: ArchitectureJobResponse };
    await waitForTerminal(job.id); // reaches "failed", never "ready"

    const acceptResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/proposals/${job.id}/accept`,
      { body: {}, email: "owner-ai15@example.com", method: "POST" },
    );
    expect(acceptResponse.status).toBe(422);
  });

  it("rejects an unknown job id for both the status and accept routes with 404", async () => {
    const diagram = await createDiagram(
      "AI unknown job test",
      "owner-ai16@example.com",
    );
    const statusResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/proposals/does-not-exist`,
      { email: "owner-ai16@example.com" },
    );
    expect(statusResponse.status).toBe(404);

    const acceptResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/proposals/does-not-exist/accept`,
      { body: {}, email: "owner-ai16@example.com", method: "POST" },
    );
    expect(acceptResponse.status).toBe(404);
  });

  it("rejects a new proposal for a diagram whose current document already exceeds the node bound", async () => {
    const diagram = await createDiagram(
      "AI oversized diagram test",
      "owner-ai17@example.com",
    );
    const manyNodes = Array.from({ length: 61 }, (_, index) => ({
      id: `bulk-${index}`,
      type: "actor",
      position: { x: index, y: index },
      data: { kind: "external-actor", label: `Node ${index}` },
    }));
    const replaceResponse = await authenticatedRequest(
      `/api/diagrams/${diagram.id}/operations`,
      {
        body: {
          operationId: "seed-oversized",
          baseRevision: 1,
          kind: "replace_document",
          payload: {
            document: {
              version: 1,
              nodes: manyNodes,
              edges: [],
              viewport: { x: 0, y: 0, zoom: 1 },
            },
          },
        },
        email: "owner-ai17@example.com",
        method: "POST",
      },
    );
    expect(replaceResponse.status).toBe(200);

    const response = await startProposal(
      diagram.id,
      "owner-ai17@example.com",
      fixturePrompt("valid"),
    );
    expect(response.status).toBe(422);
  });
});
