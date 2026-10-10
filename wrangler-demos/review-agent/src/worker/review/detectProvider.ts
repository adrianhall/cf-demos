import type {
  GitProviderClient,
  PrReference,
  Provider,
} from "../providers/types";

/** The result of successfully matching a pasted PR/MR URL against one provider's own
 * `parsePrUrl()` (docs/07-PR-REVIEW-AGENT.md, "API And Routing"'s `POST /api/reviews`). */
export interface DetectedPrReference {
  readonly provider: Provider;
  readonly client: GitProviderClient;
  readonly ref: PrReference;
}

/**
 * Try a pasted PR/MR URL against each provider's own `parsePrUrl()`, GitHub first (Implementation
 * Plan Phase 5, item 23's own ordering), then GitLab. Neither `GitProviderClient` implementation
 * -- nor `../providers/factory.ts`, which only dispatches by an already-known {@link Provider},
 * never by inspecting a URL -- owns centralized hostname-based routing, so this is the one place
 * that tries both provider clients' own `parsePrUrl()` in turn.
 *
 * Deliberately takes already-constructed clients rather than building them itself: this keeps
 * the function a pure dispatcher with no bindings/secrets of its own, so it stays importable
 * (and testable) from the `worker` Vitest project with no `agents` package anywhere in its
 * import graph -- unlike `../routes/reviews.ts`, which must import `./startRun.ts` (and
 * therefore `agents`) to actually start an accepted run.
 *
 * @param githubClient A `GitProviderClient` (normally a `GitHubProviderClient`) to try first.
 * @param gitlabClient A `GitProviderClient` (normally a `GitLabProviderClient`) to try second.
 * @param url The URL a signed-in user pasted into the UI.
 * @returns The first provider whose `parsePrUrl()` recognized `url` (with its resulting
 * reference and the client that recognized it), or `null` when neither provider's `parsePrUrl()`
 * matched.
 */
export function detectProviderAndRef(
  githubClient: GitProviderClient,
  gitlabClient: GitProviderClient,
  url: string,
): DetectedPrReference | null {
  const githubRef = githubClient.parsePrUrl(url);
  if (githubRef !== null) {
    return { provider: "github", client: githubClient, ref: githubRef };
  }
  const gitlabRef = gitlabClient.parsePrUrl(url);
  if (gitlabRef !== null) {
    return { provider: "gitlab", client: gitlabClient, ref: gitlabRef };
  }
  return null;
}
