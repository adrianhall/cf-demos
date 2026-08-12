import { describe, expect, it, vi } from "vitest";
import { GitHubProviderClient } from "./github";
import { hmacSha256Hex } from "./webhook-crypto";

const WEBHOOK_SECRET = "test-github-webhook-secret";

/** Build a `Request` shaped like a real inbound GitHub `pull_request` webhook delivery. */
async function githubWebhookRequest(
  payload: unknown,
  options: { signature?: string; deliveryId?: string | null } = {},
): Promise<Request> {
  const body = JSON.stringify(payload);
  const signature =
    options.signature ?? `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, body)}`;
  const headers = new Headers({ "x-hub-signature-256": signature });
  if (options.deliveryId !== null) {
    headers.set("x-github-delivery", options.deliveryId ?? "delivery-123");
  }
  return new Request("https://example.com/api/webhooks/github", {
    method: "POST",
    headers,
    body,
  });
}

/** A minimal, well-formed `pull_request` webhook payload. */
function pullRequestPayload(overrides: { action?: string } = {}) {
  return {
    action: overrides.action ?? "opened",
    pull_request: {
      number: 42,
      html_url: "https://github.com/octo-org/octo-repo/pull/42",
      title: "Add a feature",
      user: { login: "octocat" },
      head: { sha: "abc123def456" },
    },
    repository: { full_name: "octo-org/octo-repo" },
  };
}

/** Build a client with a `fetch` mock that throws on any unexpected URL, so a test can never
 * accidentally succeed via a real network call. */
function clientWithFetch(fetchImpl: ReturnType<typeof vi.fn>) {
  return new GitHubProviderClient({
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

describe("GitHubProviderClient.parsePrUrl", () => {
  const client = clientWithFetch(unreachableFetch());

  it("parses a valid PR URL", () => {
    const ref = client.parsePrUrl(
      "https://github.com/octo-org/octo-repo/pull/42",
    );

    expect(ref).toEqual({
      provider: "github",
      repoFullName: "octo-org/octo-repo",
      owner: "octo-org",
      repo: "octo-repo",
      prNumber: 42,
      headSha: "",
    });
  });

  it("parses a valid PR URL with a trailing slash", () => {
    const ref = client.parsePrUrl(
      "https://github.com/octo-org/octo-repo/pull/42/",
    );

    expect(ref?.prNumber).toBe(42);
  });

  it.each([
    "https://gitlab.com/octo-org/octo-repo/pull/42",
    "https://github.com/octo-org/octo-repo/issues/42",
    "https://github.com/octo-org/octo-repo/pull/not-a-number",
    "https://github.com/octo-org/octo-repo",
    "not a url at all",
    "",
  ])("returns null for %s", (url) => {
    expect(client.parsePrUrl(url)).toBeNull();
  });
});

describe("GitHubProviderClient.verifyWebhook", () => {
  it("verifies a correctly signed opened event and normalizes it", async () => {
    const client = clientWithFetch(unreachableFetch());
    const request = await githubWebhookRequest(pullRequestPayload());

    const event = await client.verifyWebhook(
      request,
      JSON.stringify(pullRequestPayload()),
    );

    expect(event).toEqual({
      ref: {
        provider: "github",
        repoFullName: "octo-org/octo-repo",
        owner: "octo-org",
        repo: "octo-repo",
        prNumber: 42,
        headSha: "abc123def456",
      },
      action: "opened",
      deliveryId: "delivery-123",
      prTitle: "Add a feature",
      prAuthor: "octocat",
      prUrl: "https://github.com/octo-org/octo-repo/pull/42",
      changedFiles: null,
    });
  });

  it.each(["synchronize", "reopened"])(
    "also verifies the %s tracked action",
    async (action) => {
      const client = clientWithFetch(unreachableFetch());
      const payload = pullRequestPayload({ action });
      const request = await githubWebhookRequest(payload);

      const event = await client.verifyWebhook(
        request,
        JSON.stringify(payload),
      );

      expect(event?.action).toBe(action);
    },
  );

  it("returns null for a recognized but untracked action", async () => {
    const client = clientWithFetch(unreachableFetch());
    const payload = pullRequestPayload({ action: "closed" });
    const request = await githubWebhookRequest(payload);

    const event = await client.verifyWebhook(request, JSON.stringify(payload));

    expect(event).toBeNull();
  });

  it("returns null for an invalid signature", async () => {
    const client = clientWithFetch(unreachableFetch());
    const payload = pullRequestPayload();
    const request = await githubWebhookRequest(payload, {
      signature:
        "sha256=0000000000000000000000000000000000000000000000000000000000000000",
    });

    const event = await client.verifyWebhook(request, JSON.stringify(payload));

    expect(event).toBeNull();
  });

  it("returns null for a signature computed with the wrong secret", async () => {
    const client = clientWithFetch(unreachableFetch());
    const payload = pullRequestPayload();
    const body = JSON.stringify(payload);
    const wrongSignature = `sha256=${await hmacSha256Hex("wrong-secret", body)}`;
    const request = await githubWebhookRequest(payload, {
      signature: wrongSignature,
    });

    const event = await client.verifyWebhook(request, body);

    expect(event).toBeNull();
  });

  it("returns null when the signature header is missing", async () => {
    const client = clientWithFetch(unreachableFetch());
    const payload = pullRequestPayload();
    const body = JSON.stringify(payload);
    const request = new Request("https://example.com", {
      method: "POST",
      headers: { "x-github-delivery": "delivery-123" },
      body,
    });

    const event = await client.verifyWebhook(request, body);

    expect(event).toBeNull();
  });

  it("returns null when the delivery id header is missing", async () => {
    const client = clientWithFetch(unreachableFetch());
    const payload = pullRequestPayload();
    const request = await githubWebhookRequest(payload, { deliveryId: null });

    const event = await client.verifyWebhook(request, JSON.stringify(payload));

    expect(event).toBeNull();
  });

  it("returns null for an unparseable body", async () => {
    const client = clientWithFetch(unreachableFetch());
    const body = "not json";
    const signature = `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, body)}`;
    const request = new Request("https://example.com", {
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-delivery": "delivery-123",
      },
      body,
    });

    const event = await client.verifyWebhook(request, body);

    expect(event).toBeNull();
  });

  it("returns null for a well-formed but unrecognized payload shape", async () => {
    const client = clientWithFetch(unreachableFetch());
    const body = JSON.stringify({ action: "opened" });
    const signature = `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, body)}`;
    const request = new Request("https://example.com", {
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-delivery": "delivery-123",
      },
      body,
    });

    const event = await client.verifyWebhook(request, body);

    expect(event).toBeNull();
  });

  it("returns null when the parsed body is valid JSON but not an object", async () => {
    const client = clientWithFetch(unreachableFetch());
    const body = JSON.stringify("just a string");
    const signature = `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, body)}`;
    const request = new Request("https://example.com", {
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-delivery": "delivery-123",
      },
      body,
    });

    const event = await client.verifyWebhook(request, body);

    expect(event).toBeNull();
  });

  it("returns null when action is present but not a string", async () => {
    const client = clientWithFetch(unreachableFetch());
    const body = JSON.stringify({ action: 42 });
    const signature = `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, body)}`;
    const request = new Request("https://example.com", {
      method: "POST",
      headers: {
        "x-hub-signature-256": signature,
        "x-github-delivery": "delivery-123",
      },
      body,
    });

    const event = await client.verifyWebhook(request, body);

    expect(event).toBeNull();
  });

  it("returns null when repository.full_name has no owner/repo separator", async () => {
    const client = clientWithFetch(unreachableFetch());
    const payload = {
      ...pullRequestPayload(),
      repository: { full_name: "no-slash-here" },
    };
    const request = await githubWebhookRequest(payload);

    const event = await client.verifyWebhook(request, JSON.stringify(payload));

    expect(event).toBeNull();
  });
});

const REF = {
  provider: "github" as const,
  repoFullName: "octo-org/octo-repo",
  owner: "octo-org",
  repo: "octo-repo",
  prNumber: 42,
  headSha: "abc123def456",
};

describe("GitHubProviderClient.fetchDiff", () => {
  it("concatenates a single page of files into a diff", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/repos/octo-org/octo-repo/pulls/42/files");
      expect(url).toContain("page=1");
      return new Response(
        JSON.stringify([
          { filename: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
          { filename: "package-lock.json", patch: "huge generated diff" },
          // GitHub omits `patch` entirely for a binary/oversized file.
          { filename: "assets/logo.png" },
        ]),
        { status: 200 },
      );
    });
    const client = clientWithFetch(fetchImpl);

    const result = await client.fetchDiff(REF);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.changedFiles).toEqual(["src/a.ts", "assets/logo.png"]);
    expect(result.diff).toContain("src/a.ts");
    expect(result.diff).not.toContain("package-lock.json");
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
          filename: `vendor/dep-${index}.lock`,
          patch: "generated diff",
        }));
        return new Response(JSON.stringify(files), { status: 200 });
      }
      expect(url).toContain("page=2");
      // A shorter page (45 < per_page) of real files -- more than the 40-file cap, so this
      // should both stop pagination (page shorter than per_page) AND report truncation.
      const files = Array.from({ length: 45 }, (_, index) => ({
        filename: `src/file-${index}.ts`,
        patch: "diff",
      }));
      return new Response(JSON.stringify(files), { status: 200 });
    });
    const client = clientWithFetch(fetchImpl);

    const result = await client.fetchDiff(REF);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.changedFiles).toHaveLength(40);
    expect(result.truncated).toBe(true);
  });

  it("throws on a non-2xx files response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const client = clientWithFetch(fetchImpl);

    await expect(client.fetchDiff(REF)).rejects.toThrow(/500/);
  });
});

describe("GitHubProviderClient.getFileContent", () => {
  it("decodes and returns base64 file content", async () => {
    const original = "export const x = 1;\n";
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/repos/octo-org/octo-repo/contents/src/index.ts");
      expect(url).toContain("ref=abc123def456");
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

  it("returns null when the response has no string content field (a directory listing)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify([{ name: "a" }, { name: "b" }]), {
          status: 200,
        }),
    );
    const client = clientWithFetch(fetchImpl);

    const result = await client.getFileContent(REF, "src");

    expect(result).toBeNull();
  });
});

describe("GitHubProviderClient.resolvePrMetadata", () => {
  it("resolves the current head SHA, title, author, and URL from the single-PR endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/repos/octo-org/octo-repo/pulls/42");
      expect(url).not.toContain("/pulls/42/files");
      return new Response(
        JSON.stringify({
          head: { sha: "fresh-head-sha" },
          title: "Add a feature (updated)",
          user: { login: "octocat" },
          html_url: "https://github.com/octo-org/octo-repo/pull/42",
        }),
        { status: 200 },
      );
    });
    const client = clientWithFetch(fetchImpl);

    const metadata = await client.resolvePrMetadata({ ...REF, headSha: "" });

    expect(metadata).toEqual({
      headSha: "fresh-head-sha",
      title: "Add a feature (updated)",
      author: "octocat",
      url: "https://github.com/octo-org/octo-repo/pull/42",
    });
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not found", { status: 404 }),
    );
    const client = clientWithFetch(fetchImpl);

    await expect(client.resolvePrMetadata(REF)).rejects.toThrow(/404/);
  });

  it("throws when called with a GitLab reference instead of a GitHub one", async () => {
    const client = clientWithFetch(unreachableFetch());

    await expect(client.resolvePrMetadata(GITLAB_REF)).rejects.toThrow(
      /gitlab reference/,
    );
  });
});

describe("GitHubProviderClient.postComment", () => {
  it("posts to the issues comments endpoint and returns the created comment's URL", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/repos/octo-org/octo-repo/issues/42/comments");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({
        body: "Great PR!",
      });
      return new Response(
        JSON.stringify({
          html_url:
            "https://github.com/octo-org/octo-repo/pull/42#issuecomment-1",
        }),
        { status: 201 },
      );
    });
    const client = clientWithFetch(fetchImpl);

    const result = await client.postComment(REF, "Great PR!");

    expect(result).toEqual({
      url: "https://github.com/octo-org/octo-repo/pull/42#issuecomment-1",
    });
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
    const client = clientWithFetch(fetchImpl);

    await expect(client.postComment(REF, "body")).rejects.toThrow(/403/);
  });
});

const GITLAB_REF = {
  provider: "gitlab" as const,
  repoFullName: "group/project",
  prNumber: 1,
  headSha: "sha",
};

describe("GitHubProviderClient provider-mismatch defensive guards", () => {
  it.each([
    [
      "fetchDiff",
      (client: GitHubProviderClient) => client.fetchDiff(GITLAB_REF),
    ],
    [
      "getFileContent",
      (client: GitHubProviderClient) =>
        client.getFileContent(GITLAB_REF, "src/index.ts"),
    ],
    [
      "postComment",
      (client: GitHubProviderClient) => client.postComment(GITLAB_REF, "body"),
    ],
  ] as const)(
    "%s throws when called with a GitLab reference instead of a GitHub one",
    async (_name, call) => {
      const client = clientWithFetch(unreachableFetch());

      await expect(call(client)).rejects.toThrow(/gitlab reference/);
    },
  );
});
