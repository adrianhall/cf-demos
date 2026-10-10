import {
  badRequest,
  contentTooLarge,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";

/**
 * Request-body validation and `SKILL.md` construction for personal/enterprise skills
 * (docs/06-AGENTIC-CHAT.md Section 6.4, Phase 11, US-10). Unlike `../files/validation.ts` (which
 * runs inside the `writeMarkdown` *tool*'s own `execute()`, with no HTTP response to shape and
 * so never throws a `ProblemDetailsError`), every function here runs inside an ordinary HTTP
 * route handler (`../routes/skills.ts`/`admin.ts`), so it throws RFC 9457 errors directly --
 * mirroring `../transcribe/validation.ts`'s convention for the same reason.
 */

/** Upper bound on a skill's display name -- also the literal string a model must pass to
 * `activate_skill` (`./registry.ts`), so this stays short enough to read comfortably in a
 * `z.enum([...])` tool schema and the system prompt's catalog listing. */
export const MAX_SKILL_NAME_LENGTH = 80;

/** Upper bound on a skill's one-line description -- the only text that lands in *every* turn's
 * system prompt for every registered skill (docs/06-AGENTIC-CHAT.md US-10's "must not bloat
 * every prompt" acceptance criterion), so this is deliberately much shorter than a skill's own
 * instruction body. */
export const MAX_SKILL_DESCRIPTION_LENGTH = 300;

/** Upper bound on a skill's instruction body, whether uploaded directly or fetched from a URL
 * (`./source.ts`) -- generous for a genuine instruction bundle while still rejecting a wildly
 * oversized document before it is ever written to R2. Unlike the description above, this text
 * only ever reaches a prompt once a model actually calls `activate_skill` for this specific
 * skill (Spike D, `spikes/03-agent-skills-composability/REPORT.md` Section 5). */
export const MAX_SKILL_CONTENT_BYTES = 64 * 1024;

/**
 * Validate and normalize a skill's display name.
 *
 * @param raw The request body's raw `name` field.
 * @returns The trimmed, whitespace-collapsed name.
 * @throws {ProblemDetailsError} `400` when `raw` is not a string, `422` when nothing usable
 * remains after trimming or the result exceeds {@link MAX_SKILL_NAME_LENGTH}.
 */
export function sanitizeSkillName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw badRequest({ detail: "name must be a string." });
  }
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    throw unprocessableContent({ detail: "name must not be empty." });
  }
  if (collapsed.length > MAX_SKILL_NAME_LENGTH) {
    throw unprocessableContent({
      detail: `name must not exceed ${MAX_SKILL_NAME_LENGTH} characters.`,
    });
  }
  return collapsed;
}

/**
 * Validate and normalize a skill's one-line description. See {@link sanitizeSkillName}'s own
 * rationale for why this throws RFC 9457 errors rather than returning `null`.
 *
 * @param raw The request body's raw `description` field.
 * @returns The trimmed, whitespace-collapsed description.
 * @throws {ProblemDetailsError} `400` when `raw` is not a string, `422` when nothing usable
 * remains after trimming or the result exceeds {@link MAX_SKILL_DESCRIPTION_LENGTH}.
 */
export function sanitizeSkillDescription(raw: unknown): string {
  if (typeof raw !== "string") {
    throw badRequest({ detail: "description must be a string." });
  }
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    throw unprocessableContent({ detail: "description must not be empty." });
  }
  if (collapsed.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw unprocessableContent({
      detail: `description must not exceed ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`,
    });
  }
  return collapsed;
}

/**
 * Validate a skill's instruction body -- shared by an uploaded skill's raw request-body text
 * and a URL-sourced skill's fetched response text (`./source.ts`'s `fetchSkillSourceBody()`).
 *
 * @param raw The candidate body text.
 * @returns The trimmed body.
 * @throws {ProblemDetailsError} `400` when `raw` is not a string, `422` for an empty body, `413`
 * for a body over {@link MAX_SKILL_CONTENT_BYTES}.
 */
export function validateSkillBody(raw: unknown): string {
  if (typeof raw !== "string") {
    throw badRequest({ detail: "source.content must be a string." });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw unprocessableContent({
      detail: "The skill's content must not be empty.",
    });
  }
  const byteLength = new TextEncoder().encode(trimmed).byteLength;
  if (byteLength > MAX_SKILL_CONTENT_BYTES) {
    throw contentTooLarge({
      detail: `The skill's content must not exceed ${MAX_SKILL_CONTENT_BYTES} bytes.`,
    });
  }
  return trimmed;
}

/**
 * Quote a string for embedding in a YAML double-quoted scalar -- escapes only the two
 * characters that would otherwise break out of the quotes (`\`, `"`) or corrupt the frontmatter
 * block's own line structure (a literal newline), which is all {@link buildSkillMarkdown} ever
 * needs: every value it quotes has already been whitespace-collapsed by
 * {@link sanitizeSkillName}/{@link sanitizeSkillDescription}, so no other YAML escape sequence
 * can occur in practice.
 *
 * @param value The already-sanitized string to quote.
 * @returns `value`, wrapped in a YAML-safe double-quoted scalar.
 */
function yamlQuote(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n")}"`;
}

/**
 * Build the full `SKILL.md` content `agents/skills`'s `parseSkillMarkdown()` expects (Spike D,
 * `spikes/03-agent-skills-composability/REPORT.md` Section 4): a YAML frontmatter block carrying
 * `name`/`description`, followed by the skill's own instruction body. Always generated
 * server-side from the already-sanitized name/description fields, rather than trusting a
 * user-supplied frontmatter block -- this demo's own API contract keeps `name`/`description`
 * as separate request-body fields specifically so this function is the *only* place that
 * decides the frontmatter's shape.
 *
 * @param name The skill's already-sanitized display name.
 * @param description The skill's already-sanitized one-line description.
 * @param body The skill's already-validated instruction body.
 * @returns The complete Markdown document to write to R2 (`./storage.ts`'s
 * `putSkillMarkdown()`).
 */
export function buildSkillMarkdown(
  name: string,
  description: string,
  body: string,
): string {
  return `---\nname: ${yamlQuote(name)}\ndescription: ${yamlQuote(description)}\n---\n\n${body}\n`;
}
