/**
 * Which third-party Git host a review run, webhook delivery, or provider client belongs to.
 * Mirrors the `review_runs.provider` D1 `CHECK` constraint
 * (`migrations/0001_create_review_tables.sql`).
 */
export type Provider = "github" | "gitlab";

/**
 * Fields every normalized PR/MR reference carries, regardless of provider
 * (docs/07-PR-REVIEW-AGENT.md, "Behavior"'s `{ provider, repoFullName, prNumber, headSha }`
 * shape).
 */
interface BasePrReference {
  /** Human-readable repository identifier: `owner/repo` for GitHub, the full
   * `namespace/project` path (GitLab's own `path_with_namespace`) for GitLab. */
  readonly repoFullName: string;
  /** The PR number (GitHub) or MR internal ID, `iid` (GitLab). */
  readonly prNumber: number;
  /**
   * The commit SHA a review run should be pinned to. Populated directly from a webhook
   * payload's own head-commit field. {@link GitProviderClient.parsePrUrl} — given only a URL,
   * with no network access of its own — cannot know this value and returns the empty string for
   * it; the caller of a manual-trigger `parsePrUrl()` result (Implementation Plan Phase 5's
   * `POST /api/reviews`) is responsible for resolving the PR/MR's current head SHA (and title/
   * author/URL) via an additional provider call before this reference is used for anything that
   * reads repository content.
   */
  readonly headSha: string;
}

/**
 * A normalized GitHub PR reference. Carries `owner`/`repo` (split out of `repoFullName` once,
 * at construction time) so every method below can build a `/repos/{owner}/{repo}/...` API URL
 * without re-splitting `repoFullName` on every call.
 */
export interface GitHubPrReference extends BasePrReference {
  readonly provider: "github";
  readonly owner: string;
  readonly repo: string;
}

/**
 * A normalized GitLab MR reference. Unlike GitHub, no separate numeric-project-id field is
 * carried here: GitLab's own REST API accepts either a numeric project ID *or* a URL-encoded
 * `namespace/project` path as the `:id` path parameter
 * (https://docs.gitlab.com/api/rest/#namespaced-paths), and `repoFullName` already *is* that
 * path — every {@link GitProviderClient} method on the GitLab implementation URL-encodes it at
 * the call site instead of carrying a redundant second identifier that would otherwise need its
 * own resolution call.
 */
export interface GitLabPrReference extends BasePrReference {
  readonly provider: "gitlab";
}

/** A normalized PR (GitHub) or MR (GitLab) reference, discriminated by `provider`. */
export type PrReference = GitHubPrReference | GitLabPrReference;

/**
 * A verified, normalized inbound webhook delivery, returned by
 * {@link GitProviderClient.verifyWebhook} only for a signature/token match on a tracked action
 * (docs/07-PR-REVIEW-AGENT.md, "Git Provider Integration").
 */
export interface WebhookEvent {
  /** The normalized PR/MR this delivery is about. */
  readonly ref: PrReference;
  /** The provider's own action string for this delivery (for example GitHub's `"opened"` or
   * GitLab's `"reopen"`) -- always one this provider's client already recognized as tracked. */
  readonly action: string;
  /**
   * An opaque, provider-scoped delivery identifier, unique per actual delivery attempt --
   * GitHub's `X-GitHub-Delivery` header value; GitLab's `"<object_attributes.id>:
   * <object_attributes.updated_at>"` composite, since GitLab sends no delivery-id header at all
   * (docs/07-PR-REVIEW-AGENT.md, "Git Provider Integration"). The caller
   * (`../data/webhookDeliveries.ts`) is responsible for further prefixing this with `provider:`
   * before using it as a `review_webhook_deliveries.id` primary key -- this value alone is not
   * yet globally unique across providers.
   */
  readonly deliveryId: string;
  /** The PR/MR title at the time of this delivery. */
  readonly prTitle: string;
  /** The PR/MR author's username/login at the time of this delivery. */
  readonly prAuthor: string;
  /** The PR/MR's canonical web URL. */
  readonly prUrl: string;
  /**
   * The changed-file list, when the webhook payload itself happens to carry one. Neither
   * GitHub's `pull_request` event nor GitLab's `Merge Request Hook` payload includes a
   * changed-file list today, so every current provider client always returns `null` here --
   * `fetchDiff()` is the only path that ever populates a changed-file list in this demo. Kept
   * nullable, rather than always `[]`, so a future provider (or a provider API version that
   * starts including one) can be distinguished from "fetched, but there genuinely were no
   * changed files."
   */
  readonly changedFiles: string[] | null;
}

/** The result of {@link GitProviderClient.fetchDiff}. */
export interface FetchDiffResult {
  /** The concatenated unified diff across every non-generated changed file, capped at
   * `MAX_DIFF_CHARACTERS` (`./limits.ts`). */
  readonly diff: string;
  /** Every non-generated changed file's path, capped at `MAX_DIFF_FILES` (`./limits.ts`). */
  readonly changedFiles: string[];
  /** Whether the character cap, the file-count cap, or both caused this diff to omit content
   * that the PR/MR actually contains. */
  readonly truncated: boolean;
}

/** The result of {@link GitProviderClient.getFileContent}, or `null` when the file could not be
 * read (a non-2xx response, including a genuine 404). */
export interface FileContentResult {
  /** The file's text content, capped at `MAX_FILE_CONTENT_CHARACTERS` (`./limits.ts`). */
  readonly content: string;
  /** Whether the cap actually cut off real content. */
  readonly truncated: boolean;
}

/** The result of {@link GitProviderClient.postComment}. */
export interface PostCommentResult {
  /** The posted comment/note's own web URL, stored on `review_runs.comment_url`. */
  readonly url: string;
}

/**
 * The result of {@link GitProviderClient.resolvePrMetadata} -- everything a manually-triggered
 * run (Implementation Plan Phase 5's `POST /api/reviews`) needs but {@link
 * GitProviderClient.parsePrUrl} cannot know from a bare URL alone: the PR/MR's *current* head
 * SHA, title, author, and canonical URL, per {@link BasePrReference.headSha}'s own doc comment.
 */
export interface ResolvedPrMetadata {
  /** The PR/MR's current head commit SHA -- may have advanced past whatever a stale bookmark
   * or webhook delivery once observed; always freshly read at trigger time. */
  readonly headSha: string;
  readonly title: string;
  /** The PR (GitHub) or MR (GitLab) author's username/login. */
  readonly author: string;
  /** The PR/MR's canonical web URL, re-read from the provider rather than trusted from the
   * pasted input -- the user may have pasted a URL with different casing, a trailing slash, or
   * a `.diff`/`.patch` suffix variant that still parses but is not the canonical form. */
  readonly url: string;
}

/**
 * The provider-heterogeneity boundary this demo's Git integration is built against
 * (docs/07-PR-REVIEW-AGENT.md, "Git Provider Integration") -- one shared interface, one module
 * per provider (`./github.ts`, `./gitlab.ts`), mirroring the "one small interface, one file per
 * implementation" shape `demos/ai-chat/src/worker/chat/adapters/` uses for model-shape
 * heterogeneity. Every method is a pure function of its inputs plus whatever `fetch`/secret the
 * implementing class was constructed with, so a test can substitute a scripted `fetch` and never
 * make a real network call.
 */
export interface GitProviderClient {
  /**
   * Parse a PR (GitHub) or MR (GitLab) web URL into a normalized reference, for the manual
   * "paste a URL" trigger path (Implementation Plan Phase 5).
   *
   * @param url The URL a signed-in user pasted into the UI.
   * @returns The normalized reference (with `headSha` empty -- see {@link BasePrReference}), or
   * `null` when `url` does not match this provider's PR/MR URL shape at all.
   */
  parsePrUrl(url: string): PrReference | null;

  /**
   * Resolve a PR/MR's *current* head SHA, title, author, and canonical URL directly from the
   * provider's REST API -- the additional provider call {@link parsePrUrl}'s own doc comment
   * says a manual-trigger caller (Implementation Plan Phase 5's `POST /api/reviews`) is
   * responsible for making before using its result for anything that reads repository content.
   * Unlike a webhook delivery (whose payload already carries this data for free, at the moment
   * of that specific delivery), a pasted URL carries none of it, so this is the one place a
   * manual trigger actually reads the PR/MR's live state.
   *
   * @param ref A reference from {@link parsePrUrl} (its `headSha` is empty and ignored here --
   * this method re-derives it from the provider, never trusts a caller-supplied value).
   * @returns The PR/MR's current metadata.
   * @throws {Error} On a non-2xx response from the provider's single-PR/MR lookup endpoint
   * (including a genuine `404` for a PR/MR number that does not exist) -- deliberately not
   * `null`-returning like {@link getFileContent}, since there is no legitimate "not found but
   * not an error" outcome for a URL a user just pasted expecting a real PR/MR to exist.
   */
  resolvePrMetadata(ref: PrReference): Promise<ResolvedPrMetadata>;

  /**
   * Verify an inbound webhook request's signature/token and, only on a match for a tracked
   * action, parse it into a normalized {@link WebhookEvent}.
   *
   * @param request The inbound webhook `Request`, read only for its headers -- never its body
   * (already consumed into `rawBody` by the caller, since a `Request` body can only be read
   * once).
   * @param rawBody The exact raw request body bytes, as text -- signing/verification must run
   * over the untouched bytes, not a `JSON.parse()`d-and-re-stringified copy.
   * @returns The normalized event, or `null` on any signature/token mismatch, an unparseable
   * body, an unrecognized payload shape, or a recognized-but-untracked action.
   */
  verifyWebhook(
    request: Request,
    rawBody: string,
  ): Promise<WebhookEvent | null>;

  /**
   * Fetch a PR/MR's unified diff and changed-file list, capped for cost/abuse control
   * (docs/07-PR-REVIEW-AGENT.md, "Git Provider Integration").
   *
   * @param ref The PR/MR to fetch.
   * @returns The capped diff, changed-file list, and whether either cap actually truncated it.
   * @throws {Error} On a non-2xx response from the provider's files/diffs endpoint.
   */
  fetchDiff(ref: PrReference): Promise<FetchDiffResult>;

  /**
   * Read one file's content from the PR/MR's own head commit, for the reviewer personas'
   * `getFileContent` tool (Implementation Plan Phase 4).
   *
   * @param ref The PR/MR whose head commit `path` should be read from.
   * @param path The repository-relative file path to read.
   * @returns The capped content, or `null` when the provider responds with anything other than
   * a successful `200`.
   */
  getFileContent(
    ref: PrReference,
    path: string,
  ): Promise<FileContentResult | null>;

  /**
   * Post a comment (GitHub) or note (GitLab) on the PR/MR.
   *
   * @param ref The PR/MR to comment on.
   * @param body The comment's Markdown body.
   * @returns The created comment/note's own web URL.
   * @throws {Error} On a non-2xx response from the provider's comment/note-creation endpoint.
   */
  postComment(ref: PrReference, body: string): Promise<PostCommentResult>;
}
