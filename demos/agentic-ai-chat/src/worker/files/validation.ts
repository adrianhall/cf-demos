/**
 * Filename/content sanitization and validation for the `writeMarkdown` tool
 * (docs/06-AGENTIC-CHAT.md Phase 9, US-8). Neither function throws a `ProblemDetailsError` --
 * unlike this demo's HTTP route validators (for example `../transcribe/validation.ts`), this
 * module runs inside a tool's own `execute()` function, with no HTTP response to shape; a
 * rejection here becomes a plain, human-readable tool result the model can explain to the user
 * (`../agent/tools/write-markdown.ts`), never an unhandled exception that aborts the turn
 * (Section 11).
 */

/** Upper bound on a sanitized filename's length, leaving room for the `.md` extension this
 * module always appends. */
const MAX_FILENAME_LENGTH = 128;

/** Upper bound on one document's Markdown content, generous for the kind of note/report this
 * tool is meant for while still rejecting a wildly oversized generation before it is ever
 * written to R2. */
export const MAX_CONTENT_BYTES = 256 * 1024;

/**
 * Normalize a model-supplied filename into something safe to use as an R2 key component and to
 * present back to the user -- collapses everything outside a small safe charset to `-`, strips
 * any path separators or leading dots (so this can never be interpreted as a directory
 * traversal or a hidden file, even though {@link ../files/storage.ts!chatFileKey} already
 * namespaces every file under a server-generated id, not this filename directly), replaces any
 * existing extension with exactly one `.md`, and truncates to {@link MAX_FILENAME_LENGTH}.
 * Mirrors `../chats/title.ts`'s `sanitizeTitle()` "normalize, or report nothing usable" style,
 * rather than throwing, since this demo's `writeMarkdown` tool needs a filename it can trust
 * unconditionally once this function returns non-`null`.
 *
 * @param raw The model's raw `filename` tool-call argument.
 * @returns The sanitized filename (always ending in `.md`), or `null` if nothing usable
 * remained -- the caller must treat `null` as a validation failure, not persist it.
 */
export function sanitizeFilename(raw: string): string | null {
  // `String.prototype.split()` always returns at least one element, even for an empty or
  // separator-free `raw`, so indexing its last element (unlike `.pop()`, typed
  // `string | undefined` for every array) needs no defensive fallback.
  const segments = raw.split(/[/\\]/u);
  const base = segments[segments.length - 1];
  // Strip a trailing extension of any kind (not only an existing ".md") so this function's own
  // ".md" is always the only extension left on the result, never appended on top of another.
  const withoutExtension = base.replace(/\.[A-Za-z0-9]{1,10}$/u, "");
  const safe = withoutExtension
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "");
  if (safe.length === 0) {
    return null;
  }
  // `safe` (per the replace chain above) contains no whitespace at all, so a non-empty `safe`
  // sliced to a positive length is always itself still non-empty -- no further "still nothing
  // usable after truncation" check is reachable here.
  return `${safe.slice(0, MAX_FILENAME_LENGTH - 3)}.md`;
}

/**
 * Validate one document's Markdown content before it is ever written to R2.
 *
 * @param content The model's raw `content` tool-call argument.
 * @returns `content`, unchanged.
 * @throws {Error} A plain (not RFC 9457) error for an empty document or one exceeding
 * {@link MAX_CONTENT_BYTES} -- caught by `../agent/tools/write-markdown.ts`'s own
 * `writeMarkdownFile()` and turned into a structured tool-result failure, never an unhandled
 * exception (Section 11).
 */
export function validateMarkdownContent(content: string): string {
  if (content.trim().length === 0) {
    throw new Error("content must not be empty.");
  }
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength > MAX_CONTENT_BYTES) {
    throw new Error(`content must not exceed ${MAX_CONTENT_BYTES} bytes.`);
  }
  return content;
}
