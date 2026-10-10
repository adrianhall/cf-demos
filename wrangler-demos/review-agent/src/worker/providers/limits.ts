import type { FetchDiffResult, FileContentResult } from "./types";

/** Character cap on a run's concatenated diff (docs/07-PR-REVIEW-AGENT.md, "Git Provider
 * Integration": "a documented character cap (for example 60,000 characters, matching demo 5's
 * message-length caps in spirit)"). Documented in `README.md`, per this repository's convention
 * for demo 5's own message caps. */
export const MAX_DIFF_CHARACTERS = 60_000;

/** File-count cap on a run's changed-file list (docs/07-PR-REVIEW-AGENT.md, "Git Provider
 * Integration": "a documented file-count cap (for example 40 files)"). */
export const MAX_DIFF_FILES = 40;

/** Character cap on one `getFileContent()` call's returned content (docs/07-PR-REVIEW-AGENT.md,
 * "Git Provider Integration": "Cap returned content (for example 20,000 characters)"). */
export const MAX_FILE_CONTENT_CHARACTERS = 20_000;

/**
 * Exact filenames treated as generated/lockfiles and skipped before either cap in
 * {@link buildDiff} ever sees them (docs/07-PR-REVIEW-AGENT.md, "Git Provider Integration":
 * "skip common generated/lockfile paths by a simple filename heuristic (`package-lock.json`,
 * `*.lock`, `pnpm-lock.yaml`, ...)").
 */
const GENERATED_FILE_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "go.sum",
]);

/**
 * Whether a changed file's path is a common generated/lockfile artifact that should never count
 * toward either the character or file-count cap.
 *
 * @param path The file's repository-relative path (GitHub's `filename`, GitLab's `new_path`).
 * @returns `true` for an exact known lockfile basename or any `*.lock` file, regardless of
 * directory.
 */
export function isGeneratedFile(path: string): boolean {
  // String.prototype.split() always returns at least one element (even for ""), so `.at(-1)`
  // can never actually be `undefined` here -- the non-null assertion documents that instead of
  // adding an unreachable `?? path` fallback branch no test could ever exercise.
  const basename = path.split("/").at(-1) as string;
  return GENERATED_FILE_BASENAMES.has(basename) || basename.endsWith(".lock");
}

/** One provider-agnostic changed-file entry, as extracted from a raw API response, before caps
 * or the generated-file skip list are applied. */
export interface DiffFileEntry {
  /** The file's repository-relative path. */
  readonly path: string;
  /** The file's unified-diff patch text, or `null` when the provider omitted one (GitHub omits
   * `patch` for binary/oversized files; GitLab can mark a file `too_large`). */
  readonly patch: string | null;
}

/**
 * Fold a provider's already-fetched (and already paginated) list of changed-file entries into
 * the capped `{ diff, changedFiles, truncated }` shape every {@link GitProviderClient} (`./types.ts`)
 * implementation's `fetchDiff()` returns. Applies the generated-file skip list before either cap
 * counts an entry, per docs/07-PR-REVIEW-AGENT.md's "Git Provider Integration".
 *
 * @param entries Every changed-file entry the caller collected across as many pages as it chose
 * to fetch, in provider-returned order.
 * @returns The concatenated, capped diff text; the (capped) list of non-generated changed-file
 * paths; and whether the file-count cap, the character cap, or a skipped generated file's own
 * page count meant this diff omits content the PR/MR actually contains.
 */
export function buildDiff(entries: readonly DiffFileEntry[]): FetchDiffResult {
  const changedFiles: string[] = [];
  const diffParts: string[] = [];
  let length = 0;
  let truncated = false;

  for (const entry of entries) {
    if (isGeneratedFile(entry.path)) {
      continue;
    }
    if (changedFiles.length >= MAX_DIFF_FILES) {
      truncated = true;
      break;
    }
    changedFiles.push(entry.path);

    if (!entry.patch) {
      continue;
    }
    const remaining = MAX_DIFF_CHARACTERS - length;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    const chunk = `--- ${entry.path} ---\n${entry.patch}\n`;
    if (chunk.length > remaining) {
      diffParts.push(chunk.slice(0, remaining));
      length = MAX_DIFF_CHARACTERS;
      truncated = true;
    } else {
      diffParts.push(chunk);
      length += chunk.length;
    }
  }

  return { diff: diffParts.join(""), changedFiles, truncated };
}

/**
 * Cap a file's decoded text content at {@link MAX_FILE_CONTENT_CHARACTERS}.
 *
 * @param content The file's already-decoded text content.
 * @returns The capped content and whether the cap actually cut it off.
 */
export function capFileContent(content: string): FileContentResult {
  if (content.length <= MAX_FILE_CONTENT_CHARACTERS) {
    return { content, truncated: false };
  }
  return {
    content: content.slice(0, MAX_FILE_CONTENT_CHARACTERS),
    truncated: true,
  };
}

/**
 * Decode a provider's base64 file-content response as UTF-8 text. Both GitHub's Contents API
 * and GitLab's Repository Files API return base64 with embedded newlines (GitHub) or a plain
 * base64 string (GitLab); `Buffer` (available via this Worker's `nodejs_compat` compatibility
 * flag) tolerates either.
 *
 * @param base64 The provider response's raw `content` field.
 * @returns The decoded UTF-8 text.
 */
export function decodeBase64Content(base64: string): string {
  return Buffer.from(base64.replaceAll("\n", ""), "base64").toString("utf-8");
}
