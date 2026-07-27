import {
  badRequest,
  notFound,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import type { CreateTodoInput, UpdateTodoInput } from "./types";

const MAX_TITLE_LENGTH = 280;

/** UUID format accepted for TODO path parameters. */
export const TODO_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Normalize a task title and enforce its display-safe length limit.
 *
 * @param value Candidate task title.
 * @returns Trimmed title.
 * @throws {ProblemDetailsError} When the title is empty or exceeds the permitted length.
 */
function validateTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw unprocessableContent({ detail: "title is required." });
  }

  const title = value.trim();
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw unprocessableContent({
      detail: "title must be between 1 and 280 characters.",
    });
  }
  return title;
}

/**
 * Ensure a JSON value is an object suitable for a TODO payload.
 *
 * @param value Parsed JSON value.
 * @returns Object payload with string keys.
 * @throws {ProblemDetailsError} When the body is not an object.
 */
function validateObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest({ detail: "The request body must be an object." });
  }
  return value as Record<string, unknown>;
}

/**
 * Validate a create-TODO request payload.
 *
 * @param value Parsed JSON body.
 * @returns Validated creation input.
 * @throws {ProblemDetailsError} When the body shape or title is invalid.
 */
export function validateCreateTodoInput(value: unknown): CreateTodoInput {
  const body = validateObject(value);
  if (Object.keys(body).some((key) => key !== "title")) {
    throw unprocessableContent({ detail: "Only title may be supplied." });
  }
  return { title: validateTitle(body.title) };
}

/**
 * Validate a partial TODO update payload.
 *
 * @param value Parsed JSON body.
 * @returns Validated mutable fields.
 * @throws {ProblemDetailsError} When no mutable field is supplied or a field is invalid.
 */
export function validateUpdateTodoInput(value: unknown): UpdateTodoInput {
  const body = validateObject(value);
  const keys = Object.keys(body);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== "title" && key !== "completed")
  ) {
    throw unprocessableContent({
      detail: "Supply title and/or completed only.",
    });
  }

  const input: UpdateTodoInput = {};
  if (Object.hasOwn(body, "title")) {
    input.title = validateTitle(body.title);
  }
  if (Object.hasOwn(body, "completed")) {
    if (typeof body.completed !== "boolean") {
      throw unprocessableContent({ detail: "completed must be a boolean." });
    }
    input.completed = body.completed;
  }
  return input;
}

/**
 * Validate a TODO UUID path parameter without revealing whether another user's task exists.
 *
 * @param id Candidate TODO identifier.
 * @returns Validated UUID.
 * @throws {ProblemDetailsError} When the ID is malformed.
 */
export function validateTodoId(id: string): string {
  if (!TODO_ID_PATTERN.test(id)) {
    throw notFound({ detail: "TODO not found." });
  }
  return id;
}
