import {
  badRequest,
  notFound,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import { isBlueprintId } from "../../graph/blueprints";
import type { CreateDiagramInput, UpdateDiagramInput } from "./types";

const MAX_TITLE_LENGTH = 200;
/** RFC 4122 UUID, matching `crypto.randomUUID()`'s output shape. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Validate a diagram title shared by create and rename requests.
 *
 * @param value Candidate title.
 * @returns Trimmed, validated title.
 * @throws {ProblemDetailsError} When the title is missing, empty, or too long.
 */
function validateTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw unprocessableContent({ detail: "title is required." });
  }
  const title = value.trim();
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw unprocessableContent({
      detail: `title must be between 1 and ${MAX_TITLE_LENGTH} characters.`,
    });
  }
  return title;
}

/**
 * Validate `POST /api/diagrams`'s request body.
 *
 * @param value Parsed JSON body.
 * @returns Validated creation input.
 * @throws {ProblemDetailsError} When the body shape, title, or blueprint id is invalid.
 */
export function validateCreateDiagramInput(value: unknown): CreateDiagramInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest({ detail: "The request body must be an object." });
  }
  const { title, blueprintId } = value as Record<string, unknown>;
  const validatedTitle = validateTitle(title);
  if (blueprintId === undefined) {
    return { title: validatedTitle };
  }
  if (typeof blueprintId !== "string" || !isBlueprintId(blueprintId)) {
    throw unprocessableContent({ detail: "blueprintId is not recognized." });
  }
  return { title: validatedTitle, blueprintId };
}

/**
 * Validate `PATCH /api/diagrams/:id`'s request body.
 *
 * @param value Parsed JSON body.
 * @returns Validated rename input.
 * @throws {ProblemDetailsError} When the body shape or title is invalid.
 */
export function validateUpdateDiagramInput(value: unknown): UpdateDiagramInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest({ detail: "The request body must be an object." });
  }
  const { title } = value as Record<string, unknown>;
  return { title: validateTitle(title) };
}

/**
 * Validate a path parameter as a diagram UUID.
 *
 * A malformed id is treated identically to a nonexistent one — `404`, not `400` — so a caller
 * cannot distinguish "no such id shape" from "not your diagram" by probing the API.
 *
 * @param id Candidate path parameter.
 * @returns The validated UUID.
 * @throws {ProblemDetailsError} `notFound()` when `id` is not a well-formed UUID.
 */
export function validateDiagramId(id: string): string {
  if (!UUID_PATTERN.test(id)) {
    throw notFound({ detail: "Diagram not found." });
  }
  return id;
}
