import { defineStore } from "pinia";

/** One `diagram_members` row, as returned by `GET /api/diagrams/:id/members`. */
export interface DiagramMember {
  /** Verified Cloudflare Access email of the member. */
  email: string;
  /** `"owner"` (exactly one per diagram) or `"editor"`. */
  role: "owner" | "editor";
}

/** RFC 9457 response fields displayed to the caller. */
interface ProblemDetails {
  /** User-safe explanation of a failed request. */
  detail?: string;
  /** Standard status text fallback. */
  title?: string;
}

/** Convert an unsuccessful same-origin API response into a user-safe error message. */
async function requestErrorMessage(response: Response): Promise<string> {
  try {
    const problem = (await response.json()) as ProblemDetails;
    return (
      problem.detail ?? problem.title ?? "The request could not be completed."
    );
  } catch {
    return "The request could not be completed.";
  }
}

/**
 * Shared client state for one diagram's member list.
 *
 * Visible to every member — owner and editor alike — unlike `./diagram-invitations.ts`'s
 * owner-only invitation management. `MemberList.vue` renders this for both roles;
 * `InviteDialog.vue`'s invite/revoke controls are what `DiagramEditorView.vue` hides for a
 * non-owner, not this store.
 */
export const useDiagramMembersStore = defineStore("diagram-members", {
  actions: {
    /**
     * Fetch a diagram's current members.
     *
     * @param diagramId Diagram to list members for.
     */
    async load(diagramId: string): Promise<void> {
      this.loading = true;
      this.error = "";
      try {
        const response = await fetch(
          `/api/diagrams/${encodeURIComponent(diagramId)}/members`,
        );
        if (!response.ok) {
          this.error = await requestErrorMessage(response);
          return;
        }
        const body = (await response.json()) as { members: DiagramMember[] };
        this.members = body.members;
      } finally {
        this.loading = false;
      }
    },
  },
  state: () => ({
    /** User-safe message from the most recent failed request, if any. */
    error: "",
    /** Whether the initial load request is pending. */
    loading: false,
    /** Most recently fetched members, owner first. */
    members: [] as DiagramMember[],
  }),
});
