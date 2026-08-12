import { describe, expect, it, vi } from "vitest";
import { GitLabProviderClient } from "./gitlab";

const WEBHOOK_SECRET = "test-gitlab-webhook-secret";

function gitlabWebhookRequest(
  payload: unknown,
  options: { token?: string | null } = {},
): Request {
  const headers = new Headers();
  if (options.token !== null) {
    headers.set("x-gitlab-token", options.token ?? WEBHOOK_SECRET);
  }
  return new Request("https://example.com/api/webhooks/gitlab", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

function mergeRequestPayload(overrides: { action?: string } = {}) {
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    user: { username: "agarcia" },
    project: { path_with_namespace: "flightjs/flight-management" },
    object_attributes: {
      id: 93,
      iid: 16,
      action: overrides.action ?? "open",
      title: "Add input validation",
      url: "https://gitlab.com/flightjs/flight-management/-/merge_requests/16",
      updated_at: "2026-01-16 05:56:25 UTC",
      last_commit: { id: "e59094b8de0f2f91abbe4760a52d9137260252d8" },
    },
  };
}

function clientWithFetch(fetchImpl: ReturnType<typeof vi.fn>) {
  return new GitLabProviderClient({
    token: "test-token",
    webhookSecret: WEBHOOK_SECRET,
    fetch: fetchImpl as unknown as typeof fetch,
  });
}

function unreachableFetch() {
  return vi.fn(async () => {
    throw new Error("unexpected real network call");
  });
}

describe("GitLabProviderClient.parsePrUrl", () => {
  const client = clientWithFetch(unreachableFetch());

  it("parses a valid MR URL", () => {
    const ref = client.parsePrUrl(
      "https://gitlab.com/flightjs/flight-management/-/merge_requests/16",
    );

    expect(ref).toEqual({
      provider: "gitlab",
      repoFullName: "flightjs/flight-management",
      prNumber: 16,
      headSha: "",
    });
  });

  it("parses a valid MR URL with a nested namespace", () => {
    const ref = client.parsePrUrl(
      "https://gitlab.com/my-group/my-subgroup/my-project/-/merge_requests/3",
    );

    expect(ref).toEqual({
      provider: "gitlab",
      repoFullName: "my-group/my-subgroup/my-project",
      prNumber: 3,
      headSha: "",
    });
  });

  it("parses an MR URL against a configured self-managed base URL", () => {
    const selfManaged = clientWithFetch(unreachableFetch());
    const selfManagedWithBaseUrl = new GitLabProviderClient({
      token: "test-token",
      webhookSecret: WEBHOOK_SECRET,
      fetch: unreachableFetch() as unknown as typeof fetch,
      baseUrl: "https://gitlab.example.com",
    });

    expect(
      selfManaged.parsePrUrl(
        "https://gitlab.example.com/group/project/-/merge_requests/1",
      ),
    ).toBeNull();
    expect(
      selfManagedWithBaseUrl.parsePrUrl(
        "https://gitlab.example.com/group/project/-/merge_requests/1",
      ),
    ).toEqual({
      provider: "gitlab",
      repoFullName: "group/project",
      prNumber: 1,
      headSha: "",
    });
  });

  it.each([
    "https://github.com/group/project/pull/1",
    "https://gitlab.com/group/project/issues/1",
    "https://gitlab.com/group/project/-/merge_requests/not-a-number",
    "https://gitlab.com/group/project",
    "not a url at all",
    "",
  ])("returns null for %s", (url) => {
    expect(client.parsePrUrl(url)).toBeNull();
  });
});

describe("GitLabProviderClient.verifyWebhook", () => {
  it("verifies a correctly tokened open event and normalizes it", async () => {
    const client = clientWithFetch(unreachableFetch());
    const payload = mergeRequestPayload();
    const request = gitlabWebhookRequest(payload);

    const event = await client.verifyWebhook(request, JSON.stringify(payload));

    expect(event).toEqual({
      ref: {
        provider: "gitlab",
        repoFullName: "flightjs/flight-management",
        prNumber: 16,
        headSha: "e59094b8de0f2f91abbe4760a52d9137260252d8",
      },
      action: "open",
      deliveryId: "93:2026-01-16 05:56:25 UTC",
      prTitle: "Add input validation",
      prAuthor: "agarcia",
      prUrl:
        "https://gitlab.com/flightjs/flight-management/-/merge_requests/16",
      changedFiles: null,
    });
  });

  it.each(["update", "reopen"])(
    "also verifies the %s tracked action",
    async (action) => {
      const client = clientWithFetch(unreachableFetch());
      const payload = mergeRequestPayload({ action });
      const request = gitlabWebhookRequest(payload);

      const event = await client.verifyWebhook(
        request,
        JSON.stringify(payload),
      );

      expect(event?.action).toBe(action);
    },
  );

  it("returns null for a recognized but untracked action", async () => {
    const client = clientWithFetch(unreachableFetch());
    const payload = mergeRequestPayload({ action: "merge" });
    const request = gitlabWebhookRequest(payload);

    const event = await client.verifyWebhook(request, JSON.stringify(payload));

    expect(event).toBeNull();
  });

  it("returns null for a mismatched token", async () => {
    const client = clientWithFetch(unreachableFetch());
    const payload = mergeRequestPayload();
    const request = gitlabWebhookRequest(payload, { token: "wrong-token" });

    const event = await client.verifyWebhook(request, JSON.stringify(payload));

    expect(event).toBeNull();
  });

  it("returns null when the token header is missing", async () => {
    const client = clientWithFetch(unreachableFetch());
    const payload = mergeRequestPayload();
    const request = gitlabWebhookRequest(payload, { token: null });

    const event = await client.verifyWebhook(request, JSON.stringify(payload));

    expect(event).toBeNull();
  });

  it("returns null for an unparseable body", async () => {
    const client = clientWithFetch(unreachableFetch());
    const body = "not json";
    const request = new Request("https://example.com", {
      method: "POST",
      headers: { "x-gitlab-token": WEBHOOK_SECRET },
      body,
    });

    const event = await client.verifyWebhook(request, body);

    expect(event).toBeNull();
  });

  it("returns null for a well-formed but unrecognized payload shape (wrong object_kind)", async () => {
    const client = clientWithFetch(unreachableFetch());
    const body = JSON.stringify({ object_kind: "issue" });
    const request = new Request("https://example.com", {
      method: "POST",
      headers: { "x-gitlab-token": WEBHOOK_SECRET },
      body,
    });

    const event = await client.verifyWebhook(request, body);

    expect(event).toBeNull();
  });

  it("returns null when the parsed body is valid JSON but not an object", async () => {
    const client = clientWithFetch(unreachableFetch());
    const body = JSON.stringify(42);
    const request = new Request("https://example.com", {
      method: "POST",
      headers: { "x-gitlab-token": WEBHOOK_SECRET },
      body,
    });

    const event = await client.verifyWebhook(request, body);

    expect(event).toBeNull();
  });

  it("returns null when user.username is missing", async () => {
    const client = clientWithFetch(unreachableFetch());
    const payload = { ...mergeRequestPayload(), user: {} };
    const request = gitlabWebhookRequest(payload);

    const event = await client.verifyWebhook(request, JSON.stringify(payload));

    expect(event).toBeNull();
  });

  it("returns null when project.path_with_namespace is missing", async () => {
    const client = clientWithFetch(unreachableFetch());
    const payload = { ...mergeRequestPayload(), project: {} };
    const request = gitlabWebhookRequest(payload);

    const event = await client.verifyWebhook(request, JSON.stringify(payload));

    expect(event).toBeNull();
  });

  it("returns null when object_attributes is missing entirely", async () => {
    const client = clientWithFetch(unreachableFetch());
    const { object_attributes: _omit, ...rest } = mergeRequestPayload();
    const request = gitlabWebhookRequest(rest);

    const event = await client.verifyWebhook(request, JSON.stringify(rest));

    expect(event).toBeNull();
  });
});

const REF = {
  provider: "gitlab" as const,
  repoFullName: "flightjs/flight-management",
  prNumber: 16,
  headSha: "e59094b8de0f2f91abbe4760a52d9137260252d8",
};

describe("GitLabProviderClient.fetchDiff", () => {
  it("concatenates a single page of diffs, skipping generated files", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain(
        "/projects/flightjs%2Fflight-management/merge_requests/16/diffs",
      );
      expect(url).toContain("page=1");
      return new Response(
        JSON.stringify([
          { new_path: "src/a.ts", diff: "@@ -1 +1 @@\n-old\n+new" },
          { new_path: "pnpm-lock.yaml", diff: "huge generated diff" },
          // GitLab omits `diff` for a `too_large` file.
          { new_path: "assets/logo.png" },
        ]),
        { status: 200 },
      );
    });
    const client = clientWithFetch(fetchImpl);

    const result = await client.fetchDiff(REF);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.changedFiles).toEqual(["src/a.ts", "assets/logo.png"]);
    expect(result.diff).not.toContain("pnpm-lock.yaml");
    expect(result.truncated).toBe(false);
  });

  it("paginates across pages until enough non-generated files are collected", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      call += 1;
      if (call === 1) {
        expect(url).toContain("page=1");
        // A full page (100 entries, matching per_page) that is entirely generated files, so
        // fetchDiff() must not stop just because the page came back full -- it should keep
        // paginating until it either has enough non-generated files or a short page ends it.
        const files = Array.from({ length: 100 }, (_, index) => ({
          new_path: `vendor/dep-${index}.lock`,
          diff: "generated diff",
        }));
        return new Response(JSON.stringify(files), { status: 200 });
      }
      expect(url).toContain("page=2");
      // A shorter page (45 < per_page) of real files -- more than the 40-file cap, so this
      // should both stop pagination (page shorter than per_page) AND report truncation.
      const files = Array.from({ length: 45 }, (_, index) => ({
        new_path: `src/file-${index}.ts`,
        diff: "diff",
      }));
      return new Response(JSON.stringify(files), { status: 200 });
    });
    const client = clientWithFetch(fetchImpl);

    const result = await client.fetchDiff(REF);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.changedFiles).toHaveLength(40);
    expect(result.truncated).toBe(true);
  });

  it("throws on a non-2xx diffs response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const client = clientWithFetch(fetchImpl);

    await expect(client.fetchDiff(REF)).rejects.toThrow(/500/);
  });
});

describe("GitLabProviderClient.getFileContent", () => {
  it("decodes and returns base64 file content", async () => {
    const original = "export const x = 1;\n";
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain(
        "/projects/flightjs%2Fflight-management/repository/files/src%2Findex.ts",
      );
      expect(url).toContain("ref=e59094b8de0f2f91abbe4760a52d9137260252d8");
      return new Response(
        JSON.stringify({
          content: Buffer.from(original, "utf-8").toString("base64"),
          encoding: "base64",
        }),
        { status: 200 },
      );
    });
    const client = clientWithFetch(fetchImpl);

    const result = await client.getFileContent(REF, "src/index.ts");

    expect(result).toEqual({ content: original, truncated: false });
  });

  it("returns null for a non-2xx response (including a genuine 404)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not found", { status: 404 }),
    );
    const client = clientWithFetch(fetchImpl);

    const result = await client.getFileContent(REF, "missing.ts");

    expect(result).toBeNull();
  });

  it("returns null when the response has no string content field", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ file_name: "x" }), { status: 200 }),
    );
    const client = clientWithFetch(fetchImpl);

    const result = await client.getFileContent(REF, "src/index.ts");

    expect(result).toBeNull();
  });
});

describe("GitLabProviderClient.resolvePrMetadata", () => {
  it("resolves the current head SHA, title, author, and URL from the single-MR endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain(
        "/projects/flightjs%2Fflight-management/merge_requests/16",
      );
      expect(url).not.toContain("/merge_requests/16/diffs");
      return new Response(
        JSON.stringify({
          sha: "fresh-head-sha",
          title: "Add input validation (updated)",
          author: { username: "agarcia" },
          web_url:
            "https://gitlab.com/flightjs/flight-management/-/merge_requests/16",
        }),
        { status: 200 },
      );
    });
    const client = clientWithFetch(fetchImpl);

    const metadata = await client.resolvePrMetadata({ ...REF, headSha: "" });

    expect(metadata).toEqual({
      headSha: "fresh-head-sha",
      title: "Add input validation (updated)",
      author: "agarcia",
      url: "https://gitlab.com/flightjs/flight-management/-/merge_requests/16",
    });
  });

  it("falls back to diff_refs.head_sha when sha is null", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sha: null,
            diff_refs: { head_sha: "from-diff-refs" },
            title: "Add input validation",
            author: { username: "agarcia" },
            web_url:
              "https://gitlab.com/flightjs/flight-management/-/merge_requests/16",
          }),
          { status: 200 },
        ),
    );
    const client = clientWithFetch(fetchImpl);

    const metadata = await client.resolvePrMetadata(REF);

    expect(metadata.headSha).toBe("from-diff-refs");
  });

  it("throws when neither sha nor diff_refs.head_sha is present", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sha: null,
            title: "Add input validation",
            author: { username: "agarcia" },
            web_url:
              "https://gitlab.com/flightjs/flight-management/-/merge_requests/16",
          }),
          { status: 200 },
        ),
    );
    const client = clientWithFetch(fetchImpl);

    await expect(client.resolvePrMetadata(REF)).rejects.toThrow(
      /no head SHA yet/,
    );
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not found", { status: 404 }),
    );
    const client = clientWithFetch(fetchImpl);

    await expect(client.resolvePrMetadata(REF)).rejects.toThrow(/404/);
  });

  it("throws when called with a GitHub reference instead of a GitLab one", async () => {
    const client = clientWithFetch(unreachableFetch());

    await expect(client.resolvePrMetadata(GITHUB_REF)).rejects.toThrow(
      /github reference/,
    );
  });
});

describe("GitLabProviderClient.postComment", () => {
  it("posts to the merge request notes endpoint and builds the note's URL from its id", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain(
        "/projects/flightjs%2Fflight-management/merge_requests/16/notes",
      );
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({
        body: "Great MR!",
      });
      return new Response(JSON.stringify({ id: 555 }), { status: 201 });
    });
    const client = clientWithFetch(fetchImpl);

    const result = await client.postComment(REF, "Great MR!");

    expect(result).toEqual({
      url: "https://gitlab.com/flightjs/flight-management/-/merge_requests/16#note_555",
    });
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    const client = clientWithFetch(fetchImpl);

    await expect(client.postComment(REF, "body")).rejects.toThrow(/403/);
  });
});

const GITHUB_REF = {
  provider: "github" as const,
  repoFullName: "octo-org/octo-repo",
  owner: "octo-org",
  repo: "octo-repo",
  prNumber: 1,
  headSha: "sha",
};

describe("GitLabProviderClient provider-mismatch defensive guards", () => {
  it.each([
    [
      "fetchDiff",
      (client: GitLabProviderClient) => client.fetchDiff(GITHUB_REF),
    ],
    [
      "getFileContent",
      (client: GitLabProviderClient) =>
        client.getFileContent(GITHUB_REF, "src/index.ts"),
    ],
    [
      "postComment",
      (client: GitLabProviderClient) => client.postComment(GITHUB_REF, "body"),
    ],
  ] as const)(
    "%s throws when called with a GitHub reference instead of a GitLab one",
    async (_name, call) => {
      const client = clientWithFetch(unreachableFetch());

      await expect(call(client)).rejects.toThrow(/github reference/);
    },
  );
});
