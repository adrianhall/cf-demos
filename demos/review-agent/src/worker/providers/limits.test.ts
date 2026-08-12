import { describe, expect, it } from "vitest";
import {
  buildDiff,
  capFileContent,
  decodeBase64Content,
  isGeneratedFile,
  MAX_DIFF_CHARACTERS,
  MAX_DIFF_FILES,
  MAX_FILE_CONTENT_CHARACTERS,
} from "./limits";

describe("isGeneratedFile", () => {
  it.each([
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "composer.lock",
    "Gemfile.lock",
    "Cargo.lock",
    "go.sum",
    "nested/dir/package-lock.json",
    "vendor/some-tool.lock",
  ])("treats %s as a generated file to skip", (path) => {
    expect(isGeneratedFile(path)).toBe(true);
  });

  it.each(["src/index.ts", "README.md", "package.json", "locking-utils.ts"])(
    "does not treat %s as a generated file",
    (path) => {
      expect(isGeneratedFile(path)).toBe(false);
    },
  );
});

describe("buildDiff", () => {
  it("concatenates every non-generated file's patch with a per-file header", () => {
    const result = buildDiff([
      { path: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
      { path: "src/b.ts", patch: "@@ -2 +2 @@\n-foo\n+bar" },
    ]);

    expect(result.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.diff).toContain("--- src/a.ts ---");
    expect(result.diff).toContain("--- src/b.ts ---");
    expect(result.truncated).toBe(false);
  });

  it("skips generated files before they count toward either cap", () => {
    const result = buildDiff([
      { path: "package-lock.json", patch: "huge lockfile diff" },
      { path: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
    ]);

    expect(result.changedFiles).toEqual(["src/a.ts"]);
    expect(result.diff).not.toContain("package-lock.json");
    expect(result.diff).not.toContain("huge lockfile diff");
    expect(result.truncated).toBe(false);
  });

  it("caps the changed-file list at MAX_DIFF_FILES and marks the result truncated", () => {
    const entries = Array.from({ length: MAX_DIFF_FILES + 5 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      patch: "diff",
    }));

    const result = buildDiff(entries);

    expect(result.changedFiles).toHaveLength(MAX_DIFF_FILES);
    expect(result.changedFiles).toEqual(
      entries.slice(0, MAX_DIFF_FILES).map((entry) => entry.path),
    );
    expect(result.truncated).toBe(true);
  });

  it("caps the concatenated diff text at MAX_DIFF_CHARACTERS and marks it truncated", () => {
    const bigPatch = "x".repeat(MAX_DIFF_CHARACTERS);
    const result = buildDiff([
      { path: "src/big.ts", patch: bigPatch },
      { path: "src/small.ts", patch: "small diff" },
    ]);

    expect(result.diff.length).toBeLessThanOrEqual(MAX_DIFF_CHARACTERS);
    expect(result.diff).not.toContain("small diff");
    expect(result.truncated).toBe(true);
    // The first file's changed path is still recorded even though its patch was cut off --
    // "truncated" describes the diff *text*, not omission of the file from the file list.
    expect(result.changedFiles).toContain("src/big.ts");
  });

  it("records a changed file with no patch (binary/oversized) without adding diff text", () => {
    const result = buildDiff([{ path: "assets/logo.png", patch: null }]);

    expect(result.changedFiles).toEqual(["assets/logo.png"]);
    expect(result.diff).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("returns an empty, non-truncated result for no entries", () => {
    const result = buildDiff([]);

    expect(result).toEqual({ diff: "", changedFiles: [], truncated: false });
  });
});

describe("capFileContent", () => {
  it("returns content unchanged when under the cap", () => {
    expect(capFileContent("short content")).toEqual({
      content: "short content",
      truncated: false,
    });
  });

  it("truncates content over MAX_FILE_CONTENT_CHARACTERS and reports it", () => {
    const longContent = "a".repeat(MAX_FILE_CONTENT_CHARACTERS + 100);

    const result = capFileContent(longContent);

    expect(result.content).toHaveLength(MAX_FILE_CONTENT_CHARACTERS);
    expect(result.truncated).toBe(true);
  });
});

describe("decodeBase64Content", () => {
  it("decodes plain base64 (GitLab's shape) as UTF-8 text", () => {
    const original = "export const answer = 42;\n";
    const base64 = Buffer.from(original, "utf-8").toString("base64");

    expect(decodeBase64Content(base64)).toBe(original);
  });

  it("decodes base64 with embedded newlines (GitHub's Contents API shape)", () => {
    const original = "line one\nline two\n";
    const base64 = Buffer.from(original, "utf-8").toString("base64");
    const withNewlines = `${base64.slice(0, 4)}\n${base64.slice(4)}`;

    expect(decodeBase64Content(withNewlines)).toBe(original);
  });

  it("decodes multi-byte UTF-8 content correctly", () => {
    const original = "caf\u00e9 \u2705";
    const base64 = Buffer.from(original, "utf-8").toString("base64");

    expect(decodeBase64Content(base64)).toBe(original);
  });
});
