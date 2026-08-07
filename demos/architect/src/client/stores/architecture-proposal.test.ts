import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobProgressFrame } from "../../collaboration-protocol";
import { useArchitectureProposalStore } from "./architecture-proposal";

const job = {
  id: "job-1",
  diagramId: "d-1",
  baseRevision: 1,
  requesterEmail: "owner@example.com",
  status: "queued" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("useArchitectureProposalStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    useArchitectureProposalStore().stopPolling();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("start() posts the prompt and stores the returned job", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ job, duplicate: false }), {
          status: 201,
        }),
      ),
    );
    const store = useArchitectureProposalStore();
    await store.start("d-1", "Build an API");

    expect(store.job).toEqual(job);
    expect(store.diagramId).toBe("d-1");
    expect(store.isActive).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/diagrams/d-1/proposals",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("start() records a user-safe error on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ detail: "A proposal is already in progress." }),
          {
            status: 409,
          },
        ),
      ),
    );
    const store = useArchitectureProposalStore();
    await store.start("d-1", "Build an API");
    expect(store.error).toBe("A proposal is already in progress.");
    expect(store.job).toBeNull();
  });

  it("handleJobProgress() ignores a frame for a different job", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ job }), { status: 201 }),
        ),
    );
    const store = useArchitectureProposalStore();
    await store.start("d-1", "Build an API");

    store.handleJobProgress({
      type: "job_progress",
      jobId: "some-other-job",
      status: "ready",
      updatedAt: "2026-01-01T00:01:00.000Z",
    } satisfies JobProgressFrame);

    expect(store.job?.status).toBe("queued");
  });

  it("handleJobProgress() updates status and, on a terminal frame, refreshes for the proposal document", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            job: { ...job, status: "ready" },
            notification: null,
            proposal: {
              version: 1,
              nodes: [],
              edges: [],
              viewport: { x: 0, y: 0, zoom: 1 },
            },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const store = useArchitectureProposalStore();
    await store.start("d-1", "Build an API");

    store.handleJobProgress({
      type: "job_progress",
      jobId: "job-1",
      status: "generating",
      updatedAt: "2026-01-01T00:00:30.000Z",
    } satisfies JobProgressFrame);
    expect(store.job?.status).toBe("generating");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    store.handleJobProgress({
      type: "job_progress",
      jobId: "job-1",
      status: "ready",
      updatedAt: "2026-01-01T00:01:00.000Z",
    } satisfies JobProgressFrame);
    // Flush the fire-and-forget refresh() triggered by the terminal frame.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.job?.status).toBe("ready");
    expect(store.proposal).toEqual({
      version: 1,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accept() dismisses the job on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job: { ...job, status: "ready" } }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: { status: "accepted" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const store = useArchitectureProposalStore();
    await store.start("d-1", "Build an API");

    const accepted = await store.accept();
    expect(accepted).toBe(true);
    expect(store.job).toBeNull();
  });

  it("accept() sets acceptStaleness on the specific stale-base-revision rejection", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job: { ...job, status: "ready" } }), {
          status: 201,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            detail: "The diagram changed.",
            reason: "stale_base_revision",
          }),
          { status: 422 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const store = useArchitectureProposalStore();
    await store.start("d-1", "Build an API");

    const accepted = await store.accept();
    expect(accepted).toBe(false);
    expect(store.acceptStaleness).toBe(true);
    expect(store.job).not.toBeNull();
  });

  it("dismiss() clears all tracked state", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ job }), { status: 201 }),
        ),
    );
    const store = useArchitectureProposalStore();
    await store.start("d-1", "Build an API");
    store.dismiss();

    expect(store.job).toBeNull();
    expect(store.diagramId).toBeNull();
    expect(store.proposal).toBeNull();
    expect(store.notification).toBeNull();
  });

  it("setSocketConnected(false) starts a polling fallback that stops once the job is terminal", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ job }), { status: 201 }),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            job: { ...job, status: "ready" },
            notification: null,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const store = useArchitectureProposalStore();
    await store.start("d-1", "Build an API");

    store.setSocketConnected(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.job?.status).toBe("ready");

    // The job is now terminal; a further tick must not poll again.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("isActive is false once the job is ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ job: { ...job, status: "ready" } }), {
          status: 201,
        }),
      ),
    );
    const store = useArchitectureProposalStore();
    await store.start("d-1", "Build an API");
    expect(store.isActive).toBe(false);
  });
});
