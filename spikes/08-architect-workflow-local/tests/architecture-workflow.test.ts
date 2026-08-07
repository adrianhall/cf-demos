import { env } from "cloudflare:workers";
import { evictAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { ArchitectureJobInput, JobStatus, ProgressNotification } from "../src/contracts";

/** Waits for a local Workflow instance to settle without contacting a Cloudflare account. */
async function waitForTerminal(jobId: string): Promise<Awaited<ReturnType<WorkflowInstance["status"]>>> {
  const instance = await env.ARCHITECTURE_WORKFLOW.get(jobId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await instance.status();
    if (status.status === "complete" || status.status === "errored") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Workflow ${jobId} did not settle`);
}

/** Starts one job through the real Worker handler and asserts the HTTP acknowledgement. */
async function start(input: ArchitectureJobInput): Promise<Response> {
  return worker.fetch(new Request("https://local.test/jobs", { method: "POST", body: JSON.stringify(input) }), env);
}

/** Reads persisted room history across the Durable Object RPC boundary. */
async function history(diagramId: string): Promise<ProgressNotification[]> {
  return runInDurableObject(env.DIAGRAM_ROOM.getByName(diagramId), (room) => room.history());
}

/** Returns a new stable job input for the named fixture. */
function input(jobId: string, fixture: ArchitectureJobInput["fixture"]): ArchitectureJobInput {
  return { jobId, diagramId: `diagram-${jobId}`, baseRevision: 7, fixture };
}

beforeEach(async () => {
  // The Vitest pool owns isolated in-memory D1 state, not Wrangler's on-disk dev state.
  await env.ARCHITECT_DB.exec("CREATE TABLE IF NOT EXISTS architecture_jobs (id TEXT PRIMARY KEY, diagram_id TEXT NOT NULL, base_revision INTEGER NOT NULL, fixture TEXT NOT NULL, status TEXT NOT NULL, proposal_key TEXT, failure_reason TEXT)");
  await env.ARCHITECT_DB.exec("DELETE FROM architecture_jobs");
});

afterEach(async () => {
  await evictAllDurableObjects();
});

describe("ArchitectureWorkflow local orchestration", () => {
  it("persists ordered success progress, a stable R2 document, and durable notifications", async () => {
    const job = input("success-job", "valid");
    expect((await start(job)).status).toBe(202);
    await expect(waitForTerminal(job.jobId)).resolves.toMatchObject({ status: "complete", output: { status: "ready", proposalKey: "proposals/success-job.json" } });
    await expect(env.ARCHITECT_DB.prepare("SELECT status, proposal_key AS proposalKey FROM architecture_jobs WHERE id = ?").bind(job.jobId).first()).resolves.toEqual({ status: "ready", proposalKey: "proposals/success-job.json" });
    await expect((await env.PROPOSALS.get("proposals/success-job.json"))?.json()).resolves.toEqual({ nodes: [{ id: "edge", product: "workers" }, { id: "data", product: "d1" }], edges: [{ from: "edge", to: "data" }] });
    expect((await history(job.diagramId)).map((item) => item.status)).toEqual(["summarizing", "generating", "validating", "storing", "ready"]);
    await evictAllDurableObjects();
    expect((await history(job.diagramId)).map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it.each(["malformed", "unknown-product", "invalid-edge"] as const)("finalizes %s output as failed", async (fixture) => {
    const job = input(`${fixture}-job`, fixture);
    await start(job);
    await expect(waitForTerminal(job.jobId)).resolves.toMatchObject({ status: "complete", output: { status: "failed" } });
    await expect(env.ARCHITECT_DB.prepare("SELECT status, failure_reason AS failureReason FROM architecture_jobs WHERE id = ?").bind(job.jobId).first<{ status: JobStatus; failureReason: string }>()).resolves.toMatchObject({ status: "failed" });
    expect((await history(job.diagramId)).at(-1)).toMatchObject({ status: "failed" });
  });

  it("retries one transient generator failure and reaches ready exactly once", async () => {
    const job = input("transient-job", "transient");
    await start(job);
    await expect(waitForTerminal(job.jobId)).resolves.toMatchObject({ status: "complete", output: { status: "ready" } });
    expect((await history(job.diagramId)).map((item) => item.status)).toEqual(["summarizing", "generating", "validating", "storing", "ready"]);
  });

  it("runs durable failure finalization after generator retries are exhausted", async () => {
    const job = input("exhausted-job", "exhausted");
    await start(job);
    await expect(waitForTerminal(job.jobId)).resolves.toMatchObject({ status: "complete", output: { status: "failed" } });
    expect((await history(job.diagramId)).map((item) => item.status)).toEqual(["summarizing", "generating", "failed"]);
  });

  it("rejects a duplicate start without a second Workflow, R2 object, or notification sequence", async () => {
    const job = input("duplicate-job", "valid");
    await expect((await start(job)).json()).resolves.toEqual({ id: "duplicate-job", duplicate: false });
    await expect((await start(job)).json()).resolves.toEqual({ id: "duplicate-job", duplicate: true });
    await waitForTerminal(job.jobId);
    expect((await history(job.diagramId)).map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
  });
});
