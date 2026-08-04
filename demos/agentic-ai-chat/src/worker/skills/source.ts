import {
  badRequest,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import { validateUrlFloor } from "../egress/url-validation";
import { validateSkillBody } from "./validation";

/**
 * Fetch a URL-sourced skill's instruction body directly from the Worker (docs/06-AGENTIC-CHAT.md
 * Phase 11, US-10) -- an admin/owner-initiated, one-time ingestion call triggered by an
 * authenticated `POST /api/skills`/`POST /api/admin/skills` request, not a repeatable,
 * model-directed fetch. This is deliberately **not** routed through `../egress/gateway.ts`'s
 * Dynamic Worker sandbox (Section 6.7): that mechanism exists specifically to contain the
 * `getUrl` *tool*'s untrusted, model-chosen, repeated-per-turn destination, a materially
 * different threat model from a trusted caller supplying one URL once, up front, to seed a
 * skill's own content (see `EXPLAIN-DEMO.md` for the full rationale). {@link validateUrlFloor}
 * is reused as-is, though -- the same "http(s) only, no obviously-internal address" floor
 * applies regardless of who initiates the fetch.
 *
 * @param url The request body's raw `source.url` field.
 * @returns The fetched body text, validated exactly like an uploaded skill's own content
 * ({@link validateSkillBody}).
 * @throws {ProblemDetailsError} `400` for an invalid/internal URL or an unreachable destination,
 * `422`/`413` from {@link validateSkillBody} for an empty or oversized response body.
 */
export async function fetchSkillSourceBody(url: string): Promise<string> {
  const validation = validateUrlFloor(url);
  if (!validation.ok) {
    throw badRequest({ detail: validation.error });
  }

  let response: Response;
  try {
    response = await fetch(validation.url);
  } catch {
    throw badRequest({
      detail: `Could not fetch "${validation.url}".`,
    });
  }
  if (!response.ok) {
    throw unprocessableContent({
      detail: `Fetching "${validation.url}" failed with status ${response.status}.`,
    });
  }

  const text = await response.text();
  return validateSkillBody(text);
}
