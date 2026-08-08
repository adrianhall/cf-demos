/** Diagram record returned by the same-origin `/api/diagrams` API. */
export interface DiagramSummary {
  /** Server-generated UUID. */
  id: string;
  /** Verified Cloudflare Access identity that owns this diagram. */
  ownerEmail: string;
  /** User-editable title. */
  title: string;
  /** Optional free-text description. */
  description: string | null;
  /** JSON-serialised React Flow state: `{ nodes, edges, viewport }`. */
  graphData: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of the most recent metadata or graph update. */
  updatedAt: string;
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
 * List the signed-in identity's own diagrams, most recently updated first.
 *
 * @returns Every diagram owned by the caller.
 */
export async function listDiagrams(): Promise<DiagramSummary[]> {
  const response = await request<{ diagrams: DiagramSummary[] }>(
    "/api/diagrams",
  );
  return response.diagrams;
}

/**
 * Load one diagram by id.
 *
 * @param id Diagram id.
 * @returns The requested diagram.
 * @throws {Error} When the diagram does not exist or is not owned by the caller.
 */
export async function getDiagram(id: string): Promise<DiagramSummary> {
  const response = await request<{ diagram: DiagramSummary }>(
    `/api/diagrams/${encodeURIComponent(id)}`,
  );
  return response.diagram;
}

/**
 * Create a new diagram, optionally seeded from a blueprint template.
 *
 * @param input Optional title, description, and/or `blueprintId` to clone from.
 * @returns The newly created diagram.
 */
export async function createDiagram(input: {
  title?: string;
  description?: string;
  blueprintId?: string;
}): Promise<DiagramSummary> {
  const response = await request<{ diagram: DiagramSummary }>("/api/diagrams", {
    body: JSON.stringify(input),
    method: "POST",
  });
  return response.diagram;
}

/**
 * Rename a diagram and/or change its description.
 *
 * @param id Diagram id.
 * @param input Fields to update.
 * @returns The updated diagram.
 */
export async function updateDiagram(
  id: string,
  input: { title?: string; description?: string | null },
): Promise<DiagramSummary> {
  const response = await request<{ diagram: DiagramSummary }>(
    `/api/diagrams/${encodeURIComponent(id)}`,
    { body: JSON.stringify(input), method: "PATCH" },
  );
  return response.diagram;
}

/**
 * Autosave a diagram's complete graph.
 *
 * @param id Diagram id.
 * @param graphData JSON-serialised `{ nodes, edges, viewport }`.
 * @returns The new `updatedAt` timestamp.
 */
export async function saveDiagramGraph(
  id: string,
  graphData: string,
): Promise<string> {
  const response = await request<{ updatedAt: string }>(
    `/api/diagrams/${encodeURIComponent(id)}/graph`,
    { body: JSON.stringify({ graphData }), method: "PUT" },
  );
  return response.updatedAt;
}

/**
 * Delete a diagram.
 *
 * @param id Diagram id.
 */
export async function deleteDiagram(id: string): Promise<void> {
  const response = await fetch(`/api/diagrams/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw await requestError(response);
  }
}

/**
 * Duplicate a diagram: create a new diagram with the same title (suffixed) and clone the
 * source diagram's current graph into it. Two requests, not a server-side "duplicate"
 * endpoint -- this demo has no such route, matching CF-Architect's own client-driven
 * duplication (fetch the source, then create + save).
 *
 * @param source Diagram to duplicate.
 * @returns The newly created copy.
 */
export async function duplicateDiagram(
  source: DiagramSummary,
): Promise<DiagramSummary> {
  const copy = await createDiagram({ title: `${source.title} (copy)` });
  await saveDiagramGraph(copy.id, source.graphData);
  return { ...copy, graphData: source.graphData };
}
