/**
 * Upper bound on a persisted chat title's length. A model asked for "four words or fewer"
 * (`ChatAgent`'s title-generation prompt) usually complies, but this is a hard backstop against
 * one that ignores the instruction and returns a full sentence or more.
 */
const MAX_TITLE_LENGTH = 80;

/**
 * Normalize a model-generated title candidate into something safe to persist and render
 * (docs/06-AGENTIC-CHAT.md Phase 3, US-2): collapses internal whitespace/newlines to single
 * spaces, trims a single layer of wrapping quotes a model sometimes adds despite being told not
 * to, and truncates to {@link MAX_TITLE_LENGTH}.
 *
 * @param raw The model's raw text output for the title-generation prompt.
 * @returns The sanitized title, or an empty string if nothing usable remained (the caller must
 * treat an empty result as "no title yet", not persist it).
 */
export function sanitizeTitle(raw: string): string {
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  const unquoted = collapsed.replace(/^["'“”](.*)["'“”]$/u, "$1").trim();
  if (unquoted.length <= MAX_TITLE_LENGTH) {
    return unquoted;
  }
  return `${unquoted.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}
