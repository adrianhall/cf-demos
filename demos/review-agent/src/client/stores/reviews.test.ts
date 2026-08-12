import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewsStore } from "./reviews";

describe("useReviewsStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("loadHistory", () => {
    it("loads a page of run history", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              runs: [
                {
                  id: "run-1",
                  provider: "github",
                  repoFullName: "octo/widgets",
                  prNumber: 1,
                  prTitle: "Add feature",
                  status: "completed",
                  totalCostUsd: 0.01,
                  createdAt: "2026-08-01T00:00:00.000Z",
                  completedAt: "2026-08-01T00:05:00.000Z",
                },
              ],
              total: 1,
              page: 1,
              pageSize: 20,
            }),
            { status: 200 },
          ),
        ),
      );
      const store = useReviewsStore();

      await store.loadHistory();

      expect(store.runs).toHaveLength(1);
      expect(store.total).toBe(1);
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
      expect(fetch).toHaveBeenCalledWith("/api/reviews?page=1&pageSize=20");
    });

    it("requests the given page", async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ runs: [], total: 0, page: 3, pageSize: 20 }),
            { status: 200 },
          ),
        );
      vi.stubGlobal("fetch", fetchSpy);
      const store = useReviewsStore();

      await store.loadHistory(3);

      expect(fetchSpy).toHaveBeenCalledWith("/api/reviews?page=3&pageSize=20");
      expect(store.page).toBe(3);
    });

    it("captures the server's own problem-detail message on failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ detail: "Access expired." }), {
            status: 401,
          }),
        ),
      );
      const store = useReviewsStore();

      await store.loadHistory();

      expect(store.runs).toEqual([]);
      expect(store.error).toBe("Access expired.");
      expect(store.loading).toBe(false);
    });

    it("falls back to the response status when the error body is not JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response("upstream error", { status: 502 })),
      );
      const store = useReviewsStore();

      await store.loadHistory();

      expect(store.error).toBe("Request failed with status 502.");
    });

    it("uses a safe message when fetch itself rejects a non-Error value", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
      const store = useReviewsStore();

      await store.loadHistory();

      expect(store.error).toBe("Could not load review history.");
    });
  });

  describe("loadDetail", () => {
    it("loads one run's full detail", async () => {
      const detailBody = {
        run: {
          id: "run-1",
          provider: "github",
          repoFullName: "octo/widgets",
          prNumber: 1,
          prTitle: "Add feature",
          status: "completed",
          totalCostUsd: 0.02,
          createdAt: "2026-08-01T00:00:00.000Z",
          completedAt: "2026-08-01T00:05:00.000Z",
          workflowInstanceId: "wf-1",
          prUrl: "https://github.com/octo/widgets/pull/1",
          prAuthor: "octocat",
          headSha: "abc123",
          trigger: "manual",
          triggeredByEmail: "reviewer@example.com",
          diffTruncated: false,
          changedFileCount: 3,
          commentUrl: "https://github.com/octo/widgets/pull/1#comment",
          errorDetail: null,
          fullReport: "# Report",
        },
        reviewers: [],
        findings: [],
      };
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify(detailBody), { status: 200 }),
          ),
      );
      const store = useReviewsStore();

      await store.loadDetail("run-1");

      expect(store.detail).toEqual(detailBody);
      expect(store.detailLoading).toBe(false);
      expect(store.detailError).toBeNull();
    });

    it("captures a 404's problem-detail message for a nonexistent run", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ detail: "No review run found with id x." }),
              { status: 404 },
            ),
          ),
      );
      const store = useReviewsStore();

      await store.loadDetail("nonexistent-id");

      expect(store.detail).toBeNull();
      expect(store.detailError).toBe("No review run found with id x.");
      expect(store.detailLoading).toBe(false);
    });

    it("uses a safe message when fetch itself rejects a non-Error value", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
      const store = useReviewsStore();

      await store.loadDetail("run-1");

      expect(store.detailError).toBe("Could not load this run.");
    });
  });

  describe("triggerReview", () => {
    it("returns the new run's id on success", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ runId: "run-2", status: "running" }), {
            status: 202,
          }),
        ),
      );
      const store = useReviewsStore();

      const runId = await store.triggerReview(
        "https://github.com/owner/repo/pull/1",
      );

      expect(runId).toBe("run-2");
      expect(fetch).toHaveBeenCalledWith("/api/reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/owner/repo/pull/1" }),
      });
    });

    it("throws with the server's own rejection message on failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              detail:
                "url must be a GitHub pull request or GitLab merge request URL.",
            }),
            { status: 400 },
          ),
        ),
      );
      const store = useReviewsStore();

      await expect(store.triggerReview("https://example.com")).rejects.toThrow(
        "url must be a GitHub pull request or GitLab merge request URL.",
      );
    });
  });
});
