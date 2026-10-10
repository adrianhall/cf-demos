import type { SharedDiagram } from "./shares";

/** One row of the admin user directory, returned by `GET /api/admin/users`. */
export interface AdminUser {
  /** Verified Cloudflare Access identity email. */
  email: string;
  /** Human-readable display name; always `null` today (see the Worker's `UserDirectoryEntry`). */
  displayName: string | null;
  /** ISO-8601 timestamp recorded the first time this identity authenticated. */
  firstSeenAt: string;
  /** ISO-8601 timestamp recorded on this identity's most recent authenticated request. */
  lastSeenAt: string;
  /** Number of diagrams this identity currently owns. */
  diagramCount: number;
}

/** One page of the admin user directory. */
export interface AdminUserPage {
  /** Up to `limit` directory entries, most recently active first. */
  users: AdminUser[];
  /** Total number of distinct identities in the directory, independent of pagination. */
  total: number;
  /** The `limit` this page was fetched with. */
  limit: number;
  /** The `offset` this page was fetched with. */
  offset: number;
}

/** RFC 9457 response fields displayed to the user. */
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
 * List a page of the user directory, most recently active identity first, each row annotated
 * with how many diagrams it currently owns. Only the identity matching `ADMIN_EMAIL` can call
 * this successfully -- `requireAdmin` (`../../worker/middleware/admin.ts`) returns `403` for
 * every other authenticated identity.
 *
 * @param options Pagination window.
 * @param options.limit Maximum number of rows to return (server default 20, max 100).
 * @param options.offset Number of rows to skip before the returned page.
 * @returns The requested page of the user directory.
 * @throws {Error} When the caller is not the configured administrator.
 */
export async function listUsers(
  options: { limit?: number; offset?: number } = {},
): Promise<AdminUserPage> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) {
    params.set("limit", String(options.limit));
  }
  if (options.offset !== undefined) {
    params.set("offset", String(options.offset));
  }
  const query = params.toString();
  return request<AdminUserPage>(
    `/api/admin/users${query.length > 0 ? `?${query}` : ""}`,
  );
}

/**
 * Load one diagram's read-only fields for moderation review, regardless of owner. Returns the
 * same owner-blind projection as the public share viewer (never `ownerEmail`) -- see the
 * Worker's `GET /api/admin/diagrams/:id` JSDoc for why that is safe to expose here.
 *
 * @param diagramId Diagram id to preview.
 * @returns The diagram's read-only fields.
 * @throws {Error} When the caller is not the configured administrator, or the diagram does not
 * exist.
 */
export async function getAnyDiagram(diagramId: string): Promise<SharedDiagram> {
  const response = await request<{ diagram: SharedDiagram }>(
    `/api/admin/diagrams/${encodeURIComponent(diagramId)}`,
  );
  return response.diagram;
}

/**
 * Delete any user's diagram -- moderation, not owner self-service. Cascades to revoke every
 * share link for the diagram, the same as an owner's own delete.
 *
 * @param diagramId Diagram id to delete.
 * @throws {Error} When the caller is not the configured administrator, or the diagram does not
 * exist.
 */
export async function deleteAnyDiagram(diagramId: string): Promise<void> {
  const response = await fetch(
    `/api/admin/diagrams/${encodeURIComponent(diagramId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw await requestError(response);
  }
}
