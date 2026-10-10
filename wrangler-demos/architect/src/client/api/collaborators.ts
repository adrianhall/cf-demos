import type { DiagramSummary } from "./diagrams";

/** Collaborator record returned by the same-origin `/api/diagrams/:id/collaborators` API. */
export interface Collaborator {
  /** Diagram id the collaborator was granted access to. */
  diagramId: string;
  /** Verified Cloudflare Access identity email granted collaborator access. */
  email: string;
  /** Display name for `email`. Always `null` in this demo -- see
   * `../../worker/collaborators/types.ts`'s `Collaborator.displayName` JSDoc. */
  displayName: string | null;
  /** Email of the diagram's owner at the moment this collaborator was added. */
  addedBy: string;
  /** ISO-8601 timestamp this collaborator was added. */
  addedAt: string;
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
 * List a diagram's collaborators. Available to the diagram's owner and to any existing
 * collaborator.
 *
 * @param diagramId Diagram id.
 * @returns Every collaborator currently granted access to this diagram.
 * @throws {Error} When the diagram does not exist or the caller has no access to it.
 */
export async function listCollaborators(
  diagramId: string,
): Promise<Collaborator[]> {
  const response = await request<{ collaborators: Collaborator[] }>(
    `/api/diagrams/${encodeURIComponent(diagramId)}/collaborators`,
  );
  return response.collaborators;
}

/**
 * Grant a specific, already-known Cloudflare Access identity full edit access to a diagram.
 * Owner only.
 *
 * @param diagramId Diagram id.
 * @param email Candidate collaborator email.
 * @returns The newly added (or already-existing) collaborator row.
 * @throws {Error} `404` when `email` has never signed in to this Access application, or the
 * diagram does not exist or is not owned by the caller. `400` when `email` is the diagram's own
 * owner.
 */
export async function addCollaborator(
  diagramId: string,
  email: string,
): Promise<Collaborator> {
  const response = await request<{ collaborator: Collaborator }>(
    `/api/diagrams/${encodeURIComponent(diagramId)}/collaborators`,
    { body: JSON.stringify({ email }), method: "POST" },
  );
  return response.collaborator;
}

/**
 * Remove one collaborator from a diagram. Allowed for the diagram's owner (removing anyone) or
 * for the collaborator removing themselves ("Leave diagram").
 *
 * @param diagramId Diagram id.
 * @param email Collaborator email to remove.
 * @throws {Error} When the collaborator row does not exist, or the caller may not remove it.
 */
export async function removeCollaborator(
  diagramId: string,
  email: string,
): Promise<void> {
  const response = await fetch(
    `/api/diagrams/${encodeURIComponent(diagramId)}/collaborators/${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw await requestError(response);
  }
}

/**
 * List diagrams the signed-in identity collaborates on -- never diagrams it owns -- for the
 * dashboard's "Shared with me" section.
 *
 * @returns Diagrams the caller collaborates on, most recently updated first, each still
 * carrying `ownerEmail` so the dashboard can render "Shared by \<owner\>".
 */
export async function listSharedWithMe(): Promise<DiagramSummary[]> {
  const response = await request<{ diagrams: DiagramSummary[] }>(
    "/api/diagrams/shared-with-me",
  );
  return response.diagrams;
}
