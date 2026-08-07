import { defineStore } from "pinia";
import type { BlueprintId } from "../../graph/blueprints";

/** Diagram directory record returned by `/api/diagrams`. */
export interface DiagramSummary {
  /** Stable UUID, also the diagram's `DiagramRoom` name and route param. */
  id: string;
  /** Verified Cloudflare Access email of the diagram's owner. */
  ownerEmail: string;
  /** User-editable title. */
  title: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of the most recent title change or accepted document edit. */
  updatedAt: string;
}

/** RFC 9457 response fields displayed to the caller. */
interface ProblemDetails {
  /** User-safe explanation of a failed request. */
  detail?: string;
  /** Standard status text fallback. */
  title?: string;
}

/** Convert an unsuccessful same-origin API response into a user-safe error. */
async function requestError(response: Response): Promise<Error> {
  try {
    const problem = (await response.json()) as ProblemDetails;
    return new Error(
      problem.detail ?? problem.title ?? "The request could not be completed.",
    );
  } catch {
    return new Error("The request could not be completed.");
  }
}

/** Execute a same-origin JSON API request and return the decoded response value. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    throw await requestError(response);
  }
  return (await response.json()) as T;
}

/**
 * Shared client state and actions for the owner's diagram library.
 *
 * Phase 2 does not support deletion — see `docs/09-ARCHITECT.md`'s Phase 2 brief and
 * `../../worker/diagram-room.ts`'s `destroy()` documentation for why that is deferred.
 */
export const useDiagramsStore = defineStore("diagrams", {
  actions: {
    /**
     * Create a diagram from an optional starter blueprint and place it at the top of the list.
     *
     * @param title User-supplied diagram title.
     * @param blueprintId Starter blueprint id. Defaults to `"blank"` server-side when omitted.
     * @returns The newly created diagram summary.
     */
    async create(
      title: string,
      blueprintId?: BlueprintId,
    ): Promise<DiagramSummary> {
      const response = await request<{ diagram: DiagramSummary }>(
        "/api/diagrams",
        { body: JSON.stringify({ title, blueprintId }), method: "POST" },
      );
      this.diagrams.unshift(response.diagram);
      return response.diagram;
    },

    /** Fetch the caller's owned diagrams. */
    async load(): Promise<void> {
      this.loading = true;
      this.error = "";
      try {
        const response = await request<{ diagrams: DiagramSummary[] }>(
          "/api/diagrams",
        );
        this.diagrams = response.diagrams;
      } catch (error) {
        this.error =
          error instanceof Error
            ? error.message
            : "Could not load your diagrams.";
      } finally {
        this.loading = false;
      }
    },

    /**
     * Rename a diagram and merge the server-confirmed value into local state.
     *
     * @param id Diagram id.
     * @param title Replacement title.
     * @returns The renamed diagram summary.
     */
    async rename(id: string, title: string): Promise<DiagramSummary> {
      const response = await request<{ diagram: DiagramSummary }>(
        `/api/diagrams/${encodeURIComponent(id)}`,
        { body: JSON.stringify({ title }), method: "PATCH" },
      );
      this.diagrams = this.diagrams.map((diagram) =>
        diagram.id === id ? response.diagram : diagram,
      );
      return response.diagram;
    },
  },
  state: () => ({
    /** Most recently fetched or created diagrams, newest update first. */
    diagrams: [] as DiagramSummary[],
    /** User-safe message from the most recent failed request, if any. */
    error: "",
    /** Whether the initial list request is pending. */
    loading: false,
  }),
});
