import { describe, expect, it } from "vitest";
import type { GitHubPrReference, GitProviderClient } from "../providers/types";
import { ReviewerJsonInvalidError, runReviewer } from "./runReviewer";

const REF: GitHubPrReference = {
  provider: "github",
  owner: "octo-org",
  repo: "octo-repo",
  repoFullName: "octo-org/octo-repo",
  prNumber: 42,
  headSha: "abc123",
};

const VALID_FINDING = {
  findingRef: "CODE-001",
  severity: "medium",
  category: "TypeScript",
  filePath: "src/index.ts",
  lineNumber: 10,
  finding: "Uses `any`",
  recommendation: "Add a real type",
};

const FAKE_CLIENT: Pick<GitProviderClient, "getFileContent"> = {
  getFileContent: async () => null,
};

/**
 * A scripted fake `Ai` binding -- this repo's established no-local-simulation pattern for
 * Workers AI. Each call to `run()` returns the next queued Workers AI native-format response
 * (`{ response: "..." }`, per `workers-ai-provider`'s own `processText()`) and advances
 * `aiGatewayLogId` to a distinct value, mirroring the real binding's own mutable side-channel
 * behavior (docs/DECISIONS.md #13).
 */
function createFakeAi(responses: readonly string[]): Ai {
  let callCount = 0;
  const fake = {
    aiGatewayLogId: null as string | null,
    async run() {
      const text = responses[callCount] ?? "";
      callCount += 1;
      fake.aiGatewayLogId = `log-${callCount}`;
      return { response: text };
    },
  };
  return fake as unknown as Ai;
}

function fencedJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

describe("runReviewer", () => {
  it("returns the first turn's findings when its output parses on the first try", async () => {
    const ai = createFakeAi([`Some prose.\n${fencedJson([VALID_FINDING])}`]);

    const result = await runReviewer({
      role: "code-quality",
      ref: REF,
      diff: "diff --git a/src/index.ts b/src/index.ts",
      changedFiles: ["src/index.ts"],
      client: FAKE_CLIENT as GitProviderClient,
      ai,
      gatewayId: "gw-1",
    });

    expect(result.findings).toEqual([VALID_FINDING]);
    expect(result.aiGatewayLogId).toBe("log-1");
    expect(result.rawOutput).toContain("Some prose.");
  });

  it("succeeds on the one corrective retry when the first turn's JSON is invalid", async () => {
    const ai = createFakeAi([
      "```json\nnot valid json {{{\n```",
      fencedJson([VALID_FINDING]),
    ]);

    const result = await runReviewer({
      role: "security",
      ref: REF,
      diff: "diff",
      changedFiles: ["src/index.ts"],
      client: FAKE_CLIENT as GitProviderClient,
      ai,
      gatewayId: "gw-1",
    });

    expect(result.findings).toEqual([VALID_FINDING]);
    // The successful call was the second one -- its own gateway log id, not the first turn's.
    expect(result.aiGatewayLogId).toBe("log-2");
  });

  it("throws ReviewerJsonInvalidError when both the first turn and the retry fail to parse", async () => {
    const ai = createFakeAi([
      "```json\nnot valid json {{{\n```",
      "still not valid {{{",
    ]);

    await expect(
      runReviewer({
        role: "architecture",
        ref: REF,
        diff: "diff",
        changedFiles: ["src/index.ts"],
        client: FAKE_CLIENT as GitProviderClient,
        ai,
        gatewayId: "gw-1",
      }),
    ).rejects.toThrow(ReviewerJsonInvalidError);
  });

  it("returns an empty findings array honestly when the model reports none", async () => {
    const ai = createFakeAi([`No issues found.\n${fencedJson([])}`]);

    const result = await runReviewer({
      role: "accessibility",
      ref: REF,
      diff: "diff",
      changedFiles: ["src/App.vue"],
      client: FAKE_CLIENT as GitProviderClient,
      ai,
      gatewayId: "gw-1",
    });

    expect(result.findings).toEqual([]);
  });
});
