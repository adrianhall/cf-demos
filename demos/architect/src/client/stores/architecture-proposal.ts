import { defineStore } from "pinia";
import type {
  ArchitectureJobStatus,
  JobProgressFrame,
} from "../../collaboration-protocol";
import type { GraphDocument } from "../../graph/types";

/** `architecture_jobs` row, as returned by the proposal start/status API. */
export interface ArchitectureJobSummary {
  /** Job id — also the `ArchitectureWorkflow` instance id. */
  id: string;
  /** Diagram this proposal is for. */
  diagramId: string;
  /** The diagram's revision at the moment this job was created. */
  baseRevision: number;
  /** Verified Cloudflare Access email of the requester. */
  requesterEmail: string;
  /** Current durable status. */
  status: ArchitectureJobStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of the most recent status change. */
  updatedAt: string;
}

/** RFC 9457 response fields displayed to the caller, including this feature's own extension. */
interface ProblemDetails {
  /** User-safe explanation of a failed request. */
  detail?: string;
  /** Standard status text fallback. */
  title?: string;
  /** Present and equal to `"stale_base_revision"` only for the accept route's specific rejection. */
  reason?: string;
}

/** Interval between fallback status polls while the live WebSocket is disconnected. */
const POLL_INTERVAL_MS = 3_000;

/** Statuses that mean "the Workflow has not yet reached a terminal outcome." */
const ACTIVE_STATUSES: readonly ArchitectureJobStatus[] = [
  "queued",
  "summarizing",
  "generating",
  "validating",
  "storing",
];

/** This store's fallback poll timer, held outside Pinia's reactive state (a timer handle is not meaningful reactive UI state). */
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Extract a user-safe message (and, for the accept route, a machine-readable `reason`) from an unsuccessful response. */
async function requestProblem(response: Response): Promise<ProblemDetails> {
  try {
    return (await response.json()) as ProblemDetails;
  } catch {
    return {};
  }
}

/**
 * Shared client state for one diagram's AI architecture proposal workflow
 * (`docs/09-ARCHITECT.md`'s Phase 5): starting a job, tracking its progress, previewing the
 * result, and accepting or discarding it.
 *
 * Progress normally arrives as `job_progress` WebSocket frames, forwarded here by
 * `./diagram-document.ts`'s `applyServerFrame()` via {@link handleJobProgress} — this store does
 * not open its own connection. When the live socket is disconnected
 * ({@link setSocketConnected}), this store falls back to polling `GET
 * /api/diagrams/:id/proposals/:jobId` every {@link POLL_INTERVAL_MS} so progress is never
 * silently stuck from the user's point of view.
 */
export const useArchitectureProposalStore = defineStore(
  "architecture-proposal",
  {
    actions: {
      /**
       * Start a new proposal job for a diagram.
       *
       * @param diagramId Diagram to propose an architecture for.
       * @param prompt The user's short natural-language application description.
       */
      async start(diagramId: string, prompt: string): Promise<void> {
        this.starting = true;
        this.error = "";
        this.acceptStaleness = false;
        try {
          const response = await fetch(
            `/api/diagrams/${encodeURIComponent(diagramId)}/proposals`,
            {
              body: JSON.stringify({ prompt }),
              headers: { "Content-Type": "application/json" },
              method: "POST",
            },
          );
          const problem = response.ok ? null : await requestProblem(response);
          if (problem) {
            this.error =
              problem.detail ??
              problem.title ??
              "Could not start the proposal.";
            return;
          }
          const body = (await response.json()) as {
            job: ArchitectureJobSummary;
          };
          this.diagramId = diagramId;
          this.job = body.job;
          this.proposal = null;
          this.notification = null;
          this.syncPolling();
        } finally {
          this.starting = false;
        }
      },

      /**
       * Re-fetch the active job's current status and (once `"ready"`) its proposed document —
       * the WebSocket-disconnected fallback path, and also called once immediately after a
       * terminal `job_progress` frame to pick up the proposal document / error detail that frame
       * deliberately never carries.
       */
      async refresh(): Promise<void> {
        if (!this.diagramId || !this.job) {
          return;
        }
        const response = await fetch(
          `/api/diagrams/${encodeURIComponent(this.diagramId)}/proposals/${encodeURIComponent(this.job.id)}`,
        );
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as {
          job: ArchitectureJobSummary;
          notification: JobProgressFrame | null;
          proposal?: GraphDocument;
        };
        this.job = body.job;
        if (body.proposal) {
          this.proposal = body.proposal;
        }
        if (body.notification) {
          this.notification = body.notification;
        }
        this.syncPolling();
      },

      /**
       * Reconcile one `job_progress` frame, forwarded by `./diagram-document.ts`.
       *
       * A terminal frame (`"ready"`/`"failed"`) triggers one {@link refresh} to fetch the proposal
       * document or a detailed error — this frame itself never carries either.
       *
       * @param frame The decoded frame.
       */
      handleJobProgress(frame: JobProgressFrame): void {
        if (!this.job || frame.jobId !== this.job.id) {
          return;
        }
        this.notification = frame;
        this.job = {
          ...this.job,
          status: frame.status,
          updatedAt: frame.updatedAt,
        };
        if (!ACTIVE_STATUSES.includes(frame.status)) {
          this.stopPolling();
          void this.refresh();
        }
      },

      /**
       * Accept the current `"ready"` proposal as one atomic diagram revision.
       *
       * @returns Whether the acceptance succeeded.
       */
      async accept(): Promise<boolean> {
        if (!this.diagramId || !this.job) {
          return false;
        }
        this.accepting = true;
        this.error = "";
        this.acceptStaleness = false;
        try {
          const response = await fetch(
            `/api/diagrams/${encodeURIComponent(this.diagramId)}/proposals/${encodeURIComponent(this.job.id)}/accept`,
            { headers: { "Content-Type": "application/json" }, method: "POST" },
          );
          if (!response.ok) {
            const problem = await requestProblem(response);
            if (problem.reason === "stale_base_revision") {
              this.acceptStaleness = true;
            }
            this.error =
              problem.detail ??
              problem.title ??
              "Could not accept the proposal.";
            return false;
          }
          this.dismiss();
          return true;
        } finally {
          this.accepting = false;
        }
      },

      /** Discard the current job from view (a client-local dismissal — the server keeps its durable record). */
      dismiss(): void {
        this.stopPolling();
        this.diagramId = null;
        this.job = null;
        this.proposal = null;
        this.notification = null;
        this.error = "";
        this.acceptStaleness = false;
      },

      /**
       * Record whether the diagram's live WebSocket is currently connected, starting or stopping
       * the polling fallback accordingly.
       *
       * @param connected Whether `useDiagramDocumentStore.connectionStatus === "connected"`.
       */
      setSocketConnected(connected: boolean): void {
        this.socketConnected = connected;
        this.syncPolling();
      },

      /** Start or stop the fallback poll timer based on current job activity and socket state. */
      syncPolling(): void {
        const shouldPoll =
          !this.socketConnected &&
          this.job !== null &&
          ACTIVE_STATUSES.includes(this.job.status);
        if (shouldPoll && pollTimer === null) {
          pollTimer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
        } else if (!shouldPoll && pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      },

      /** Stop the fallback poll timer unconditionally — called on {@link dismiss}. */
      stopPolling(): void {
        if (pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      },
    },
    getters: {
      /** Whether the current job (if any) is still in a non-terminal state. */
      isActive(state): boolean {
        return state.job !== null && ACTIVE_STATUSES.includes(state.job.status);
      },
    },
    state: () => ({
      /** Diagram the current job belongs to, or `null` if no job is being tracked. */
      diagramId: null as string | null,
      /** The currently tracked job, or `null`. */
      job: null as ArchitectureJobSummary | null,
      /** The proposed document, populated once the job reaches `"ready"`. */
      proposal: null as GraphDocument | null,
      /** The most recent `job_progress` frame or polled notification, or `null`. */
      notification: null as JobProgressFrame | null,
      /** User-safe message from the most recent failed request, if any. */
      error: "",
      /** Whether the accept route rejected specifically because the diagram changed since this job's base revision. */
      acceptStaleness: false,
      /** Whether a start request is currently pending. */
      starting: false,
      /** Whether an accept request is currently pending. */
      accepting: false,
      /** Whether the diagram's live WebSocket is currently connected — see {@link setSocketConnected}. */
      socketConnected: true,
    }),
  },
);
