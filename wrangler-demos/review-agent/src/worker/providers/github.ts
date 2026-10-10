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
  GitHubPrReference,
  GitProviderClient,
  PostCommentResult,
  PrReference,
  ResolvedPrMetadata,
  WebhookEvent,
} from "./types";
import { constantTimeEqual, hmacSha256Hex } from "./webhook-crypto";

/** GitHub `pull_request` webhook actions this demo starts a review for
 * (docs/07-PR-REVIEW-AGENT.md, "Behavior"). Every other action -- `closed`, `assigned`, ... --
 * is verified successfully but yields `null` from {@link GitHubProviderClient.verifyWebhook}. */
const TRACKED_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

/** One entry from `GET /repos/{owner}/{repo}/pulls/{pull_number}/files`'s response array. */
interface GitHubDiffEntryResponse {
  readonly filename: string;
  readonly patch?: string;
}

/** The minimal shape this client reads from a GitHub `pull_request` webhook payload. Every
 * other field GitHub actually sends is ignored. */
interface GitHubPullRequestWebhookPayload {
  readonly action: string;
  readonly pull_request: {
    readonly number: number;
    readonly html_url: string;
    readonly title: string;
    readonly user: { readonly login: string };
    readonly head: { readonly sha: string };
  };
  readonly repository: { readonly full_name: string };
}

/**
 * Narrow an already-JSON-parsed webhook body to {@link GitHubPullRequestWebhookPayload},
 * tolerating any other shape (a malformed body, or a GitHub event type this demo's webhook
 * configuration should never receive in the first place) by returning `false` rather than
 * throwing.
 */
function isGitHubPullRequestPayload(
  value: unknown,
): value is GitHubPullRequestWebhookPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.action !== "string") {
    return false;
  }
  const pullRequest = record.pull_request;
  if (typeof pullRequest !== "object" || pullRequest === null) {
    return false;
  }
  const pr = pullRequest as Record<string, unknown>;
  const head = pr.head;
  const user = pr.user;
  const repository = record.repository;
  return (
    typeof pr.number === "number" &&
    typeof pr.html_url === "string" &&
    typeof pr.title === "string" &&
    typeof head === "object" &&
    head !== null &&
    typeof (head as Record<string, unknown>).sha === "string" &&
    typeof user === "object" &&
    user !== null &&
    typeof (user as Record<string, unknown>).login === "string" &&
    typeof repository === "object" &&
    repository !== null &&
    typeof (repository as Record<string, unknown>).full_name === "string"
  );
}

/** Constructor options for {@link GitHubProviderClient}. */
export interface GitHubProviderClientOptions {
  /** A GitHub personal access token (`env.GITHUB_TOKEN`), sent as `Authorization: Bearer
   * <token>` on every REST call. */
  readonly token: string;
  /** The shared secret configured on the repository's webhook (`env.GITHUB_WEBHOOK_SECRET`),
   * used to verify `X-Hub-Signature-256`. */
  readonly webhookSecret: string;
  /** Injected `fetch`, so a test can substitute a scripted implementation and make this class
   * incapable of a real network call. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** GitHub's REST API base URL. Overridable only for tests -- GitHub Enterprise Server is out
   * of scope (docs/07-PR-REVIEW-AGENT.md, "Out Of Scope"). */
  readonly apiBaseUrl?: string;
}

/** Safety bound on how many pages `fetchDiff()` will request before giving up, independent of
 * the file-count cap -- protects against an unbounded loop if GitHub ever returned a full page
 * of entries this client's own accounting never manages to cap (for example, if every entry on
 * every page were a generated file). */
const MAX_DIFF_PAGES = 30;

/** The GitHub implementation of {@link GitProviderClient} (docs/07-PR-REVIEW-AGENT.md, "Git
 * Provider Integration"). */
export class GitHubProviderClient implements GitProviderClient {
  private readonly token: string;
  private readonly webhookSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  constructor(options: GitHubProviderClientOptions) {
    this.token = options.token;
    this.webhookSecret = options.webhookSecret;
    this.fetchImpl = options.fetch ?? fetch;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  }

  /** Headers required on every authenticated GitHub REST call. */
  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
  }

  parsePrUrl(url: string): PrReference | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.hostname !== "github.com") {
      return null;
    }
    const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(parsed.pathname);
    if (!match) {
      return null;
    }
    const [, owner, repo, prNumber] = match as unknown as [
      string,
      string,
      string,
      string,
    ];
    const reference: GitHubPrReference = {
      provider: "github",
      repoFullName: `${owner}/${repo}`,
      owner,
      repo,
      prNumber: Number(prNumber),
      // Not knowable from a bare URL -- see BasePrReference.headSha's own doc comment.
      headSha: "",
    };
    return reference;
  }

  async resolvePrMetadata(ref: PrReference): Promise<ResolvedPrMetadata> {
    if (ref.provider !== "github") {
      throw new Error(
        `GitHubProviderClient.resolvePrMetadata() called with a ${ref.provider} reference`,
      );
    }
    // "Get a pull request" (https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) --
    // the single-PR endpoint, not the paginated list `fetchDiff()` already calls, since this
    // needs exactly one PR's current head/title/author/URL, not its changed files.
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/repos/${ref.owner}/${ref.repo}/pulls/${ref.prNumber}`,
      { headers: this.headers() },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub pull request lookup failed with status ${response.status}`,
      );
    }
    const body = (await response.json()) as {
      head: { sha: string };
      title: string;
      user: { login: string };
      html_url: string;
    };
    return {
      headSha: body.head.sha,
      title: body.title,
      author: body.user.login,
      url: body.html_url,
    };
  }

  async verifyWebhook(
    request: Request,
    rawBody: string,
  ): Promise<WebhookEvent | null> {
    const signatureHeader = request.headers.get("x-hub-signature-256");
    const deliveryId = request.headers.get("x-github-delivery");
    if (!signatureHeader || !deliveryId) {
      return null;
    }

    const expectedSignature = `sha256=${await hmacSha256Hex(this.webhookSecret, rawBody)}`;
    if (!constantTimeEqual(signatureHeader, expectedSignature)) {
      return null;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (!isGitHubPullRequestPayload(payload)) {
      return null;
    }
    if (!TRACKED_ACTIONS.has(payload.action)) {
      return null;
    }

    const [owner, repo] = payload.repository.full_name.split("/");
    if (!owner || !repo) {
      return null;
    }

    return {
      ref: {
        provider: "github",
        repoFullName: payload.repository.full_name,
        owner,
        repo,
        prNumber: payload.pull_request.number,
        headSha: payload.pull_request.head.sha,
      },
      action: payload.action,
      deliveryId,
      prTitle: payload.pull_request.title,
      prAuthor: payload.pull_request.user.login,
      prUrl: payload.pull_request.html_url,
      changedFiles: null,
    };
  }

  async fetchDiff(ref: PrReference): Promise<FetchDiffResult> {
    if (ref.provider !== "github") {
      throw new Error(
        `GitHubProviderClient.fetchDiff() called with a ${ref.provider} reference`,
      );
    }
    const perPage = 100;
    const entries: DiffFileEntry[] = [];

    for (let page = 1; page <= MAX_DIFF_PAGES; page += 1) {
      const response = await this.fetchImpl(
        `${this.apiBaseUrl}/repos/${ref.owner}/${ref.repo}/pulls/${ref.prNumber}/files?per_page=${perPage}&page=${page}`,
        { headers: this.headers() },
      );
      if (!response.ok) {
        throw new Error(
          `GitHub pull request files request failed with status ${response.status}`,
        );
      }
      const files = (await response.json()) as GitHubDiffEntryResponse[];
      for (const file of files) {
        entries.push({ path: file.filename, patch: file.patch ?? null });
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
    if (ref.provider !== "github") {
      throw new Error(
        `GitHubProviderClient.getFileContent() called with a ${ref.provider} reference`,
      );
    }
    const encodedPath = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/repos/${ref.owner}/${ref.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref.headSha)}`,
      { headers: this.headers() },
    );
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { content?: unknown };
    if (typeof body.content !== "string") {
      // A directory listing (an array) or an unexpected shape -- never a single file's content.
      return null;
    }
    return capFileContent(decodeBase64Content(body.content));
  }

  async postComment(
    ref: PrReference,
    body: string,
  ): Promise<PostCommentResult> {
    if (ref.provider !== "github") {
      throw new Error(
        `GitHubProviderClient.postComment() called with a ${ref.provider} reference`,
      );
    }
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/repos/${ref.owner}/${ref.repo}/issues/${ref.prNumber}/comments`,
      {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub issue comment creation failed with status ${response.status}`,
      );
    }
    const created = (await response.json()) as { html_url: string };
    return { url: created.html_url };
  }
}
