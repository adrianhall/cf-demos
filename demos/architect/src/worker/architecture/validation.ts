import {
  badRequest,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import type { StartProposalInput } from "./types";

/**
 * Maximum accepted prompt length. Kept short — this is a one-sentence application description,
 * not free-form chat — both to bound the Workers AI request and to keep the demo's per-user
 * throttle (`PROPOSAL_RATE_LIMIT_MS`) meaningful.
 */
export const MAX_PROMPT_LENGTH = 500;

/** Maximum accepted client-supplied idempotency key length. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * Maximum number of nodes an open diagram may already have before a new proposal request is
 * rejected. This bounds the size of the diagram summary sent to Workers AI (`./summary.ts`) — it
 * is unrelated to {@link import("../../graph/proposal").architectureProposalJsonSchema}'s own
 * 2-8 bound on the *proposed* nodes, which the model output schema already enforces.
 */
export const MAX_DIAGRAM_NODES_FOR_PROPOSAL = 60;

/**
 * Minimum time one requester must wait between starting two architecture proposal jobs, across
 * every diagram they can access — this demo's simple per-user start-rate throttle. Enforced by
 * comparing `Date.now()` against `ArchitectureJobRepository.mostRecentByRequester()`'s
 * `createdAt`, entirely in D1 (durable across isolates), rather than an in-memory-per-isolate
 * counter that a fresh isolate would silently reset.
 */
export const PROPOSAL_RATE_LIMIT_MS = 30_000;

/**
 * Validate `POST /api/diagrams/:id/proposals`' request body.
 *
 * @param value Parsed JSON body.
 * @returns The validated prompt and optional idempotency key.
 * @throws {ProblemDetailsError} When the body shape, prompt, or idempotency key is invalid.
 */
export function validateStartProposalInput(value: unknown): StartProposalInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest({ detail: "The request body must be an object." });
  }
  const { prompt, idempotencyKey } = value as Record<string, unknown>;
  if (typeof prompt !== "string") {
    throw unprocessableContent({ detail: "prompt is required." });
  }
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.length === 0 || trimmedPrompt.length > MAX_PROMPT_LENGTH) {
    throw unprocessableContent({
      detail: `prompt must be between 1 and ${MAX_PROMPT_LENGTH} characters.`,
    });
  }

  if (idempotencyKey === undefined) {
    return { prompt: trimmedPrompt };
  }
  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.length === 0 ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw unprocessableContent({
      detail: `idempotencyKey must be a string between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    });
  }
  return { prompt: trimmedPrompt, idempotencyKey };
}
