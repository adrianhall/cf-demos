/** Owner-facing share status returned by `GET /api/diagrams/:id/share`. */
export interface ShareStatus {
  /** Whether a read-only link is currently active for this diagram. */
  active: boolean;
  /** ISO-8601 creation timestamp of the active share, or `null` when none is active. */
  createdAt: string | null;
}

/**
 * Result of minting (or rotating) a diagram's share link, returned by `POST
 * /api/diagrams/:id/share`. This is the only response that ever carries the raw, shareable
 * `url` -- the server itself cannot recover it afterward (see `../../worker/shares/types.ts`'s
 * `ShareStatus` JSDoc).
 */
export interface CreatedShare {
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Raw share token. */
  token: string;
  /** Absolute, shareable URL: `${origin}/s/${token}`. */
  url: string;
}

/** Read-only diagram fields returned by the public `GET /api/share/:token`. */
export interface SharedDiagram {
  /** Diagram id. */
  id: string;
  /** Diagram title. */
  title: string;
  /** Diagram description, or `null`. */
  description: string | null;
  /** Live JSON-serialised React Flow state: `{ nodes, edges, viewport }`. */
  graphData: string;
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
 * Read a diagram's current share status. Never carries a token -- only the owner's `POST` call
 * (`createShare()`) ever does.
 *
 * @param diagramId Diagram id.
 * @returns The diagram's current share status.
 * @throws {Error} When the diagram does not exist or is not owned by the caller.
 */
export async function getShareStatus(diagramId: string): Promise<ShareStatus> {
  return request<ShareStatus>(
    `/api/diagrams/${encodeURIComponent(diagramId)}/share`,
  );
}

/**
 * Create (or rotate) a diagram's read-only share link. Any link previously active for this
 * diagram stops working as part of the same request.
 *
 * @param diagramId Diagram id.
 * @returns The newly minted share, including its one-time-visible raw `url`.
 * @throws {Error} When the diagram does not exist or is not owned by the caller.
 */
export async function createShare(diagramId: string): Promise<CreatedShare> {
  return request<CreatedShare>(
    `/api/diagrams/${encodeURIComponent(diagramId)}/share`,
    { method: "POST" },
  );
}

/**
 * Revoke a diagram's active share link.
 *
 * @param diagramId Diagram id.
 * @throws {Error} When the diagram does not exist, is not owned by the caller, or has no
 * active share link.
 */
export async function revokeShare(diagramId: string): Promise<void> {
  const response = await fetch(
    `/api/diagrams/${encodeURIComponent(diagramId)}/share`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw await requestError(response);
  }
}

/**
 * Resolve a public share token to its diagram's read-only fields. Anonymous -- no Cloudflare
 * Access identity required (docs/09-ARCHITECT.md's Access Model).
 *
 * @param token Share token from the `/s/:token` URL.
 * @returns The shared diagram's read-only fields.
 * @throws {Error} When the token is malformed, unknown, or was revoked.
 */
export async function getSharedDiagram(token: string): Promise<SharedDiagram> {
  const response = await request<{ diagram: SharedDiagram }>(
    `/api/share/${encodeURIComponent(token)}`,
  );
  return response.diagram;
}
