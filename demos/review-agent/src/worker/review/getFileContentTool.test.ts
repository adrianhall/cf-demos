import { describe, expect, it } from "vitest";
import type { GitHubPrReference, GitProviderClient } from "../providers/types";
import { createGetFileContentTool } from "./getFileContentTool";

const REF: GitHubPrReference = {
  provider: "github",
  owner: "octo-org",
  repo: "octo-repo",
  repoFullName: "octo-org/octo-repo",
  prNumber: 42,
  headSha: "abc123",
};

const EXECUTION_OPTIONS = { toolCallId: "call-1", messages: [], context: {} };

describe("createGetFileContentTool", () => {
  it("returns the file's content and truncated flag on success", async () => {
    const client: Pick<GitProviderClient, "getFileContent"> = {
      getFileContent: async () => ({
        content: "export const x = 1;",
        truncated: false,
      }),
    };
    const toolDefinition = createGetFileContentTool(
      client as GitProviderClient,
      REF,
    );

    const result = await toolDefinition.execute?.(
      { path: "src/index.ts" },
      EXECUTION_OPTIONS,
    );

    expect(result).toEqual({
      content: "export const x = 1;",
      truncated: false,
      error: null,
    });
  });

  it("returns a descriptive error object, not a throw, when the client returns null", async () => {
    const client: Pick<GitProviderClient, "getFileContent"> = {
      getFileContent: async () => null,
    };
    const toolDefinition = createGetFileContentTool(
      client as GitProviderClient,
      REF,
    );

    const result = await toolDefinition.execute?.(
      { path: "missing.ts" },
      EXECUTION_OPTIONS,
    );

    expect(result).toMatchObject({ content: null, truncated: false });
    expect((result as { error: string }).error).toContain("missing.ts");
  });
});
