import {
  buildDiff,
  capFileContent,
  type DiffFileEntry,
  decodeBase64Content,
  isGeneratedFile,
  MAX_DIFF_FILES,
} from "./limits";
import type {
  FetchDiffResult,
  FileContentResult,
  GitLabPrReference,
  GitProviderClient,
  PostCommentResult,
  PrReference,
  ResolvedPrMetadata,
  WebhookEvent,
} from "./types";
import { constantTimeEqual } from "./webhook-crypto";

/** GitLab `Merge Request Hook` actions this demo starts a review for
 * (docs/07-PR-REVIEW-AGENT.md, "Behavior"). Every other action -- `close`, `merge`, `approved`,
 * ... -- is verified successfully but yields `null` from
 * {@link GitLabProviderClient.verifyWebhook}. */
const TRACKED_ACTIONS = new Set(["open", "update", "reopen"]);

/** One entry from `GET /projects/:id/merge_requests/:iid/diffs`'s response array. */
interface GitLabDiffEntryResponse {
  readonly new_path: string;
  readonly diff?: string;
}

/** The minimal shape this client reads from a GitLab `Merge Request Hook` webhook payload.
 * Every other field GitLab actually sends is ignored. */
interface GitLabMergeRequestWebhookPayload {
  readonly object_kind: string;
  readonly user: { readonly username: string };
  readonly project: { readonly path_with_namespace: string };
  readonly object_attributes: {
    readonly id: number;
    readonly iid: number;
    readonly action?: string;
    readonly title: string;
    readonly url: string;
    readonly updated_at: string;
    readonly last_commit?: { readonly id: string };
  };
}

/**
 * Narrow an already-JSON-parsed webhook body to
 * {@link GitLabMergeRequestWebhookPayload}, tolerating any other shape by returning `false`
 * rather than throwing.
 */
function isGitLabMergeRequestPayload(
  value: unknown,
): value is GitLabMergeRequestWebhookPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.object_kind !== "merge_request") {
    return false;
  }
  const user = record.user;
  const project = record.project;
  const objectAttributes = record.object_attributes;
  if (
    typeof user !== "object" ||
    user === null ||
    typeof (user as Record<string, unknown>).username !== "string"
  ) {
    return false;
  }
  if (
    typeof project !== "object" ||
    project === null ||
    typeof (project as Record<string, unknown>).path_with_namespace !== "string"
  ) {
    return false;
  }
  if (typeof objectAttributes !== "object" || objectAttributes === null) {
    return false;
  }
  const attrs = objectAttributes as Record<string, unknown>;
  const lastCommit = attrs.last_commit;
  return (
    typeof attrs.id === "number" &&
    typeof attrs.iid === "number" &&
    typeof attrs.title === "string" &&
    typeof attrs.url === "string" &&
    typeof attrs.updated_at === "string" &&
    typeof lastCommit === "object" &&
    lastCommit !== null &&
    typeof (lastCommit as Record<string, unknown>).id === "string"
  );
}

/** Constructor options for {@link GitLabProviderClient}. */
export interface GitLabProviderClientOptions {
  /** A GitLab personal access token (`env.GITLAB_TOKEN`), sent as `PRIVATE-TOKEN` on every REST
   * call. */
  readonly token: string;
  /** The shared secret configured on the project's webhook (`env.GITLAB_WEBHOOK_SECRET`), sent
   * verbatim as `X-Gitlab-Token` and compared timing-safely. */
  readonly webhookSecret: string;
  /** Injected `fetch`, so a test can substitute a scripted implementation and make this class
   * incapable of a real network call. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** The GitLab instance's web root, without a trailing slash (`env.GITLAB_BASE_URL`, default
   * `https://gitlab.com`) -- used both to build the REST API base URL (`<baseUrl>/api/v4`) and
   * to match a pasted MR URL's host in {@link GitLabProviderClient.parsePrUrl}. */
  readonly baseUrl?: string;
}

/** Safety bound on how many pages `fetchDiff()` will request before giving up, mirroring
 * `./github.ts`'s own `MAX_DIFF_PAGES`. */
const MAX_DIFF_PAGES = 30;

/** The GitLab implementation of {@link GitProviderClient} (docs/07-PR-REVIEW-AGENT.md, "Git
 * Provider Integration"). */
export class GitLabProviderClient implements GitProviderClient {
  private readonly token: string;
  private readonly webhookSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly apiBaseUrl: string;

  constructor(options: GitLabProviderClientOptions) {
    this.token = options.token;
    this.webhookSecret = options.webhookSecret;
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://gitlab.com").replace(/\/$/, "");
    this.apiBaseUrl = `${this.baseUrl}/api/v4`;
  }

  /** Headers required on every authenticated GitLab REST call. */
  private headers(): Record<string, string> {
    return { "PRIVATE-TOKEN": this.token };
  }

  parsePrUrl(url: string): PrReference | null {
    let parsed: URL;
    let base: URL;
    try {
      parsed = new URL(url);
      base = new URL(this.baseUrl);
    } catch {
      return null;
    }
    if (parsed.hostname !== base.hostname) {
      return null;
    }
    const match = /^\/(.+)\/-\/merge_requests\/(\d+)\/?$/.exec(parsed.pathname);
    if (!match) {
      return null;
    }
    const [, repoFullName, prNumber] = match as unknown as [
      string,
      string,
      string,
    ];
    const reference: GitLabPrReference = {
      provider: "gitlab",
      repoFullName,
      prNumber: Number(prNumber),
      // Not knowable from a bare URL -- see BasePrReference.headSha's own doc comment.
      headSha: "",
    };
    return reference;
  }

  async resolvePrMetadata(ref: PrReference): Promise<ResolvedPrMetadata> {
    if (ref.provider !== "gitlab") {
      throw new Error(
        `GitLabProviderClient.resolvePrMetadata() called with a ${ref.provider} reference`,
      );
    }
    // "Get single MR" (https://docs.gitlab.com/api/merge_requests/#get-single-mr) -- the
    // single-MR endpoint, not the paginated `/diffs` endpoint `fetchDiff()` already calls.
    const projectId = encodeURIComponent(ref.repoFullName);
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/projects/${projectId}/merge_requests/${ref.prNumber}`,
      { headers: this.headers() },
    );
    if (!response.ok) {
      throw new Error(
        `GitLab merge request lookup failed with status ${response.status}`,
      );
    }
    const body = (await response.json()) as {
      sha?: string | null;
      diff_refs?: { head_sha?: string | null };
      title: string;
      author: { username: string };
      web_url: string;
    };
    // `sha` is GitLab's own documented "the SHA of the last commit in the merge request" field.
    // Fall back to `diff_refs.head_sha` (present on the same response) for the rare edge case
    // where `sha` reports `null` -- a merge request whose merge status GitLab has not finished
    // computing yet.
    const headSha = body.sha ?? body.diff_refs?.head_sha;
    if (!headSha) {
      throw new Error(
        `GitLab merge request ${ref.repoFullName}!${ref.prNumber} has no head SHA yet ` +
          `(merge status not yet computed)`,
      );
    }
    return {
      headSha,
      title: body.title,
      author: body.author.username,
      url: body.web_url,
    };
  }

  async verifyWebhook(
    request: Request,
    rawBody: string,
  ): Promise<WebhookEvent | null> {
    const token = request.headers.get("x-gitlab-token");
    if (!token || !constantTimeEqual(token, this.webhookSecret)) {
      return null;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!isGitLabMergeRequestPayload(payload)) {
      return null;
    }
    const action = payload.object_attributes.action;
    if (!action || !TRACKED_ACTIONS.has(action)) {
      return null;
    }

    return {
      ref: {
        provider: "gitlab",
        repoFullName: payload.project.path_with_namespace,
        prNumber: payload.object_attributes.iid,
        // The type guard above already confirmed `last_commit.id` is a string.
        headSha: (payload.object_attributes.last_commit as { id: string }).id,
      },
      action,
      deliveryId: `${payload.object_attributes.id}:${payload.object_attributes.updated_at}`,
      prTitle: payload.object_attributes.title,
      prAuthor: payload.user.username,
      prUrl: payload.object_attributes.url,
      changedFiles: null,
    };
  }

  async fetchDiff(ref: PrReference): Promise<FetchDiffResult> {
    if (ref.provider !== "gitlab") {
      throw new Error(
        `GitLabProviderClient.fetchDiff() called with a ${ref.provider} reference`,
      );
    }
    const perPage = 100;
    const entries: DiffFileEntry[] = [];
    const projectId = encodeURIComponent(ref.repoFullName);

    for (let page = 1; page <= MAX_DIFF_PAGES; page += 1) {
      const response = await this.fetchImpl(
        `${this.apiBaseUrl}/projects/${projectId}/merge_requests/${ref.prNumber}/diffs?per_page=${perPage}&page=${page}`,
        { headers: this.headers() },
      );
      if (!response.ok) {
        throw new Error(
          `GitLab merge request diffs request failed with status ${response.status}`,
        );
      }
      const files = (await response.json()) as GitLabDiffEntryResponse[];
      for (const file of files) {
        entries.push({ path: file.new_path, patch: file.diff ?? null });
      }

      const nonGeneratedCount = entries.filter(
        (entry) => !isGeneratedFile(entry.path),
      ).length;
      if (files.length < perPage || nonGeneratedCount >= MAX_DIFF_FILES) {
        break;
      }
    }

    return buildDiff(entries);
  }

  async getFileContent(
    ref: PrReference,
    path: string,
  ): Promise<FileContentResult | null> {
    if (ref.provider !== "gitlab") {
      throw new Error(
        `GitLabProviderClient.getFileContent() called with a ${ref.provider} reference`,
      );
    }
    const projectId = encodeURIComponent(ref.repoFullName);
    const filePath = encodeURIComponent(path);
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/projects/${projectId}/repository/files/${filePath}?ref=${encodeURIComponent(ref.headSha)}`,
      { headers: this.headers() },
    );
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { content?: unknown };
    if (typeof body.content !== "string") {
      return null;
    }
    return capFileContent(decodeBase64Content(body.content));
  }

  async postComment(
    ref: PrReference,
    body: string,
  ): Promise<PostCommentResult> {
    if (ref.provider !== "gitlab") {
      throw new Error(
        `GitLabProviderClient.postComment() called with a ${ref.provider} reference`,
      );
    }
    const projectId = encodeURIComponent(ref.repoFullName);
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/projects/${projectId}/merge_requests/${ref.prNumber}/notes`,
      {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitLab merge request note creation failed with status ${response.status}`,
      );
    }
    const created = (await response.json()) as { id: number };
    // GitLab's "Create a new merge request note" response has no `url`/`web_url` field
    // (verified against the current Notes API docs, https://docs.gitlab.com/api/notes/) --
    // unlike GitHub's `html_url` -- so the comment's URL is built from the same `#note_<id>`
    // anchor GitLab's own `Merge Request Hook` webhook payload uses for its comment-event
    // `object_attributes.url` (docs/07-PR-REVIEW-AGENT.md's "Git Provider Integration" describes
    // both providers as "return[ing] the created comment/note's URL" -- for GitLab that URL is
    // constructed here rather than read off the response, a deliberate deviation recorded in
    // this phase's implementation report).
    return {
      url: `${this.baseUrl}/${ref.repoFullName}/-/merge_requests/${ref.prNumber}#note_${created.id}`,
    };
  }
}
