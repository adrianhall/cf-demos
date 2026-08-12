import { defineStore } from "pinia";
import { shallowRef } from "vue";

/**
 * @file Client-side copies of this demo's REST DTO shapes (`GET /api/reviews`,
 * `GET /api/reviews/:id`, `POST /api/reviews` -- docs/07-PR-REVIEW-AGENT.md, "API And Routing").
 * Deliberately duplicated rather than imported from `../../worker/data/reviewRuns.ts`/
 * `../../worker/data/reviewFindings.ts`, matching `demos/agentic-ai-chat`'s own established
 * convention for REST-shaped data (`stores/chats.ts`'s `Chat` duplicates `ChatUsageSummary`
 * rather than importing it): those Worker modules run real D1 query code at module scope, unlike
 * `../../worker/review/types.ts` (see `../composables/useReviewRun.ts`'s own doc comment for why
 * *that* module's pure data shapes are imported directly instead) -- there is no equivalent
 * "zero runtime import" guarantee here to make importing across the Worker/client boundary safe.
 */

/** Which third-party Git host a run belongs to (`../../worker/providers/types.ts`'s
 * `Provider`, duplicated). */
export type ReviewProvider = "github" | "gitlab";

/** `review_runs.status` values (`../../worker/data/reviewRuns.ts`'s `ReviewRunStatus`,
 * duplicated). */
export type ReviewRunStatus = "running" | "completed" | "failed";

/** One of the four specialist reviewer passes (`../../worker/review/roles.ts`'s `ReviewerRole`,
 * duplicated). */
export type ReviewerRole =
  | "architecture"
  | "security"
  | "code-quality"
  | "accessibility";

/** `review_reviewers.status` values (`../../worker/data/reviewReviewers.ts`'s `ReviewerStatus`,
 * duplicated). */
export type ReviewerStatus =
  | "queued"
  | "running"
  | "done"
  | "skipped"
  | "error";

/** `review_reviewers.cost_source` values (duplicated). */
export type ReviewerCostSource = "pending" | "gateway";

/** `review_findings.priority` values (duplicated). */
export type FindingPriority = "P0" | "P1" | "P2" | "P3";

/** A single reviewer finding's own severity (duplicated). */
export type FindingSeverity = "critical" | "high" | "medium" | "low";

/** One `GET /api/reviews` history row (`../../worker/data/reviewRuns.ts`'s
 * `ReviewRunSummary`, duplicated). */
export interface ReviewRunSummary {
  readonly id: string;
  readonly provider: ReviewProvider;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly prTitle: string;
  readonly status: ReviewRunStatus;
  /** `null` when no reviewer's cost has been AI-Gateway-confirmed yet -- never blended with a
   * genuine `$0` total, matching this demo's own "pending" vs. "confirmed" cost-tracking rule. */
  readonly totalCostUsd: number | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/** One reviewer's outcome, as part of `GET /api/reviews/:id`'s full run detail
 * (`../../worker/data/reviewRuns.ts`'s `ReviewerDetail`, duplicated). */
export interface ReviewerDetail {
  readonly role: ReviewerRole;
  readonly model: string | null;
  readonly status: ReviewerStatus;
  readonly skippedReason: string | null;
  readonly errorDetail: string | null;
  readonly costUsd: number | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costSource: ReviewerCostSource;
  readonly findingCount: number;
}

/** One merged finding row (`../../worker/data/reviewFindings.ts`'s `ReviewFindingRow`,
 * duplicated). */
export interface ReviewFinding {
  readonly findingRef: string;
  readonly priority: FindingPriority;
  readonly severity: FindingSeverity;
  readonly category: string;
  readonly filePath: string | null;
  readonly lineNumber: number | null;
  readonly finding: string;
  readonly recommendation: string;
  readonly mergedFrom: string | null;
}

/** `GET /api/reviews/:id`'s full response (`../../worker/data/reviewRuns.ts`'s
 * `ReviewRunDetail`, duplicated). */
export interface ReviewRunDetail {
  readonly run: ReviewRunSummary & {
    readonly workflowInstanceId: string | null;
    readonly prUrl: string;
    readonly prAuthor: string;
    readonly headSha: string;
    readonly trigger: "webhook" | "manual";
    readonly triggeredByEmail: string | null;
    readonly diffTruncated: boolean;
    readonly changedFileCount: number;
    readonly commentUrl: string | null;
    readonly errorDetail: string | null;
    /** The run's full canonical Markdown report (`../../worker/review/report.ts`'s
     * `buildFullReport()`), or `null` before the run completes. */
    readonly fullReport: string | null;
  };
  readonly reviewers: readonly ReviewerDetail[];
  readonly findings: readonly ReviewFinding[];
}

/** RFC 9457 problem details error response shape used for safe client error messages. */
interface ProblemDetails {
  readonly detail?: string;
}

/** Read a safe error message from a failed API response. */
async function responseMessage(response: Response): Promise<string> {
  const body = (await response
    .json()
    .catch(() => null)) as ProblemDetails | null;
  return body?.detail ?? `Request failed with status ${response.status}.`;
}

/** Default page size, mirroring `../../worker/review/reviewsValidation.ts`'s
 * `DEFAULT_PAGE_SIZE` (duplicated as a plain literal rather than imported, for the same
 * "no cross-boundary import for a non-pure Worker module" reason as this file's other shapes --
 * `reviewsValidation.ts` imports and calls `zod`, a real runtime dependency). */
const DEFAULT_PAGE_SIZE = 20;

/**
 * This demo's review history and run-detail REST data (docs/07-PR-REVIEW-AGENT.md, "API And
 * Routing": `GET /api/reviews`, `GET /api/reviews/:id`, `POST /api/reviews`). Holds only the
 * REST-fetched, static half of a run's data -- the currently open run's *live* fields (reviewer
 * status/cost as they change, broadcast events) are consumed directly by `ReviewDetailView.vue`
 * from `../composables/useReviewRun.ts`, never funneled through this store, matching
 * docs/07-PR-REVIEW-AGENT.md's own Implementation Plan Phase 6, item 27 division of
 * responsibility ("state/broadcast in the composable, static REST data in the store") -- the
 * same split `demos/agentic-ai-chat` draws between `useChatsStore` (REST chat directory) and
 * `useChatStore` (the live `useChatAgent` connection).
 */
export const useReviewsStore = defineStore("reviews", () => {
  const runs = shallowRef<readonly ReviewRunSummary[]>([]);
  const total = shallowRef(0);
  const page = shallowRef(1);
  const pageSize = shallowRef(DEFAULT_PAGE_SIZE);
  const loading = shallowRef(false);
  const error = shallowRef<string | null>(null);

  const detail = shallowRef<ReviewRunDetail | null>(null);
  const detailLoading = shallowRef(false);
  const detailError = shallowRef<string | null>(null);

  /**
   * Load one page of run history, newest first.
   *
   * @param requestedPage 1-indexed page to load; defaults to the currently loaded page (or `1`
   * on the very first call), so re-running a search/refresh without arguments repeats the same
   * page rather than silently jumping back to page 1.
   */
  async function loadHistory(requestedPage = page.value): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const response = await fetch(
        `/api/reviews?page=${requestedPage}&pageSize=${pageSize.value}`,
      );
      if (!response.ok) {
        throw new Error(await responseMessage(response));
      }
      const body = (await response.json()) as {
        runs: ReviewRunSummary[];
        total: number;
        page: number;
        pageSize: number;
      };
      runs.value = body.runs;
      total.value = body.total;
      page.value = body.page;
      pageSize.value = body.pageSize;
    } catch (cause) {
      error.value =
        cause instanceof Error
          ? cause.message
          : "Could not load review history.";
    } finally {
      loading.value = false;
    }
  }

  /**
   * Load one run's full detail (reviewer rows, merged findings, full report, comment URL).
   *
   * @param id The run to load.
   */
  async function loadDetail(id: string): Promise<void> {
    detailLoading.value = true;
    detailError.value = null;
    detail.value = null;
    try {
      const response = await fetch(`/api/reviews/${encodeURIComponent(id)}`);
      if (!response.ok) {
        throw new Error(await responseMessage(response));
      }
      detail.value = (await response.json()) as ReviewRunDetail;
    } catch (cause) {
      detailError.value =
        cause instanceof Error ? cause.message : "Could not load this run.";
    } finally {
      detailLoading.value = false;
    }
  }

  /**
   * Submit a pasted PR/MR URL to start a new review (docs/07-PR-REVIEW-AGENT.md, "API And
   * Routing": `POST /api/reviews`). Does not touch {@link error} -- the trigger form
   * (`../components/ReviewTriggerForm.vue`) owns and displays its own submission error inline,
   * distinct from the history list's own {@link error}, so a failed submission never blanks out
   * an already-loaded history list.
   *
   * @param url The pasted PR/MR URL.
   * @returns The newly created (or pre-existing, per the server's own idempotent upsert) run's
   * id.
   * @throws {Error} With the server's own problem-details `detail` message when the request is
   * rejected (a malformed/unrecognized URL, or a provider lookup failure) -- the caller is
   * expected to display this message inline rather than navigate away.
   */
  async function triggerReview(url: string): Promise<string> {
    const response = await fetch("/api/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) {
      throw new Error(await responseMessage(response));
    }
    const body = (await response.json()) as { runId: string };
    return body.runId;
  }

  return {
    detail,
    detailError,
    detailLoading,
    error,
    loadDetail,
    loadHistory,
    loading,
    page,
    pageSize,
    runs,
    total,
    triggerReview,
  };
});
