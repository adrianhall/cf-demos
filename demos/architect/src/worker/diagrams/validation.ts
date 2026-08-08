import {
  badRequest,
  notFound,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import type {
  CreateDiagramInput,
  GraphData,
  UpdateDiagramInput,
} from "./types";

const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2_000;
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

/** Shape every diagram id (a server-generated `crypto.randomUUID()`) must match. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Validate a title, shared by create and update input validation.
 *
 * @param value Candidate title.
 * @returns The trimmed title.
 * @throws {ProblemDetailsError} When the title is empty or too long.
 */
function validateTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw unprocessableContent({ detail: "title must be a string." });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) {
    throw unprocessableContent({
      detail: `title must be between 1 and ${MAX_TITLE_LENGTH} characters.`,
    });
  }
  return trimmed;
}

/**
 * Validate a description, shared by create and update input validation. `null` clears the
 * description; `undefined` (the property omitted entirely) leaves it unspecified, which
 * callers distinguish from `null` by checking `"description" in value`.
 *
 * @param value Candidate description.
 * @returns The trimmed description, or `null`.
 * @throws {ProblemDetailsError} When the description is too long.
 */
function validateDescription(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw unprocessableContent({
      detail: "description must be a string or null.",
    });
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw unprocessableContent({
      detail: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
    });
  }
  return trimmed;
}

/**
 * Assert that a path parameter is a well-formed diagram id.
 *
 * @param id Candidate id from the request path.
 * @returns The validated id.
 * @throws {ProblemDetailsError} When the id is not a UUID -- reported identically to "not
 * found" (`404`), matching `demos/url-shortener`'s `validateCode()`: a malformed id and an
 * id that legitimately does not exist are indistinguishable to the caller.
 */
export function validateDiagramId(id: string): string {
  if (!UUID_PATTERN.test(id)) {
    throw notFound({ detail: "Diagram not found." });
  }
  return id;
}

/**
 * Validate a `POST /api/diagrams` request body.
 *
 * @param value Parsed JSON body.
 * @returns Validated create input.
 * @throws {ProblemDetailsError} When the body shape is invalid.
 */
export function validateCreateDiagramInput(value: unknown): CreateDiagramInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest({ detail: "The request body must be an object." });
  }

  const input: CreateDiagramInput = {};

  const title = Reflect.get(value, "title");
  if (title !== undefined) {
    input.title = validateTitle(title);
  }

  const description = Reflect.get(value, "description");
  if (description !== undefined) {
    input.description = validateDescription(description);
  }

  const blueprintId = Reflect.get(value, "blueprintId");
  if (blueprintId !== undefined) {
    if (typeof blueprintId !== "string" || blueprintId.trim().length === 0) {
      throw unprocessableContent({
        detail: "blueprintId must be a non-empty string.",
      });
    }
    input.blueprintId = blueprintId;
  }

  return input;
}

/**
 * Validate a `PATCH /api/diagrams/:id` request body.
 *
 * @param value Parsed JSON body.
 * @returns Validated update input.
 * @throws {ProblemDetailsError} When the body shape is invalid, or when it carries neither
 * `title` nor `description`.
 */
export function validateUpdateDiagramInput(value: unknown): UpdateDiagramInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest({ detail: "The request body must be an object." });
  }

  const input: UpdateDiagramInput = {};
  let sawField = false;

  const title = Reflect.get(value, "title");
  if (title !== undefined) {
    input.title = validateTitle(title);
    sawField = true;
  }

  if (Reflect.has(value, "description")) {
    input.description = validateDescription(Reflect.get(value, "description"));
    sawField = true;
  }

  if (!sawField) {
    throw unprocessableContent({
      detail: "The request body must include title and/or description.",
    });
  }

  return input;
}

/** Assert that a value is a plain JSON object (not an array, not `null`). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Assert that a value is an array of plain JSON objects, each carrying a non-empty string `id`
 * -- the one invariant every React Flow node/edge must hold. Everything else about a node or
 * edge's shape (`type`, `position`, `data`, ...) is opaque to the server (`../diagrams/types.ts`'s
 * {@link GraphData} JSDoc) and left to the `@xyflow/react` client to interpret.
 */
function validateGraphElements(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw unprocessableContent({
      detail: `graphData.${label} must be an array.`,
    });
  }
  return value.map((element, index) => {
    if (
      !isPlainObject(element) ||
      typeof element.id !== "string" ||
      element.id.length === 0
    ) {
      throw unprocessableContent({
        detail: `graphData.${label}[${index}] must be an object with a non-empty string id.`,
      });
    }
    return element;
  });
}

/**
 * Validate and canonicalize the `graphData` field of a `PUT /api/diagrams/:id/graph` request
 * body. The client always sends the *entire* graph on every autosave (there is no partial patch
 * protocol), so this fully replaces the stored value rather than merging into it.
 *
 * @param value Parsed JSON body (expected to be `{ graphData: "<json string>" }`).
 * @returns A canonical, re-serialised JSON string safe to persist -- `viewport` is always
 * present (defaulted when the client omits it) so every stored row has a uniform shape for a
 * future reader to rely on.
 * @throws {ProblemDetailsError} When the body or the nested `graphData` JSON is malformed.
 */
export function validateGraphDataInput(value: unknown): string {
  if (!isPlainObject(value)) {
    throw badRequest({ detail: "The request body must be an object." });
  }

  const raw = Reflect.get(value, "graphData");
  if (typeof raw !== "string") {
    throw unprocessableContent({ detail: "graphData must be a JSON string." });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unprocessableContent({
      detail: "graphData must contain valid JSON.",
    });
  }
  if (!isPlainObject(parsed)) {
    throw unprocessableContent({
      detail: "graphData must decode to a JSON object.",
    });
  }

  const nodes = validateGraphElements(parsed.nodes ?? [], "nodes");
  const edges = validateGraphElements(parsed.edges ?? [], "edges");

  const rawViewport = parsed.viewport;
  let viewport = DEFAULT_VIEWPORT;
  if (rawViewport !== undefined) {
    if (
      !isPlainObject(rawViewport) ||
      typeof rawViewport.x !== "number" ||
      typeof rawViewport.y !== "number" ||
      typeof rawViewport.zoom !== "number"
    ) {
      throw unprocessableContent({
        detail: "graphData.viewport must be { x, y, zoom } numbers.",
      });
    }
    viewport = { x: rawViewport.x, y: rawViewport.y, zoom: rawViewport.zoom };
  }

  const canonical: GraphData = { nodes, edges, viewport };
  return JSON.stringify(canonical);
}
