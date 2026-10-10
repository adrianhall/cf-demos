import { describe, expect, it, vi } from "vitest";
import { GitHubProviderClient } from "../providers/github";
import { GitLabProviderClient } from "../providers/gitlab";
import { detectProviderAndRef } from "./detectProvider";

/** Neither client's `parsePrUrl()` ever performs a network call, but a test double still
 * guards against one accidentally being introduced later. */
function unreachableFetch() {
  return vi.fn(async () => {
    throw new Error("unexpected real network call");
  });
}

function clients() {
  const github = new GitHubProviderClient({
    token: "test-token",
    webhookSecret: "test-secret",
    fetch: unreachableFetch() as unknown as typeof fetch,
  });
  const gitlab = new GitLabProviderClient({
    token: "test-token",
    webhookSecret: "test-secret",
    fetch: unreachableFetch() as unknown as typeof fetch,
  });
  return { github, gitlab };
}

describe("detectProviderAndRef", () => {
  it("detects a GitHub pull request URL", () => {
    const { github, gitlab } = clients();

    const detected = detectProviderAndRef(
      github,
      gitlab,
      "https://github.com/octo-org/octo-repo/pull/42",
    );

    expect(detected).toEqual({
      provider: "github",
      client: github,
      ref: {
        provider: "github",
        repoFullName: "octo-org/octo-repo",
        owner: "octo-org",
        repo: "octo-repo",
        prNumber: 42,
        headSha: "",
      },
    });
  });

  it("detects a GitLab merge request URL", () => {
    const { github, gitlab } = clients();

    const detected = detectProviderAndRef(
      github,
      gitlab,
      "https://gitlab.com/flightjs/flight-management/-/merge_requests/16",
    );

    expect(detected).toEqual({
      provider: "gitlab",
      client: gitlab,
      ref: {
        provider: "gitlab",
        repoFullName: "flightjs/flight-management",
        prNumber: 16,
        headSha: "",
      },
    });
  });

  it("tries GitHub before GitLab", () => {
    const { github, gitlab } = clients();
    const githubSpy = vi.spyOn(github, "parsePrUrl");
    const gitlabSpy = vi.spyOn(gitlab, "parsePrUrl");

    detectProviderAndRef(
      github,
      gitlab,
      "https://github.com/octo-org/octo-repo/pull/42",
    );

    expect(githubSpy).toHaveBeenCalledTimes(1);
    // GitHub already matched, so GitLab's parsePrUrl() must never even be tried.
    expect(gitlabSpy).not.toHaveBeenCalled();
  });

  it("returns null when neither provider recognizes the URL", () => {
    const { github, gitlab } = clients();

    expect(
      detectProviderAndRef(github, gitlab, "https://example.com/not-a-pr"),
    ).toBeNull();
  });

  it("returns null for an empty string", () => {
    const { github, gitlab } = clients();

    expect(detectProviderAndRef(github, gitlab, "")).toBeNull();
  });
});
