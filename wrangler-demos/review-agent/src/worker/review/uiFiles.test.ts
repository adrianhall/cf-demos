import { describe, expect, it } from "vitest";
import { hasUiRelevantChangedFile } from "./uiFiles";

describe("hasUiRelevantChangedFile", () => {
  it("returns false for an empty changed-file list", () => {
    expect(hasUiRelevantChangedFile([])).toBe(false);
  });

  it("returns false when no changed file has a UI-relevant extension", () => {
    expect(
      hasUiRelevantChangedFile([
        "src/worker/routes/webhooks.ts",
        "migrations/0002_add_column.sql",
        "README.md",
      ]),
    ).toBe(false);
  });

  it.each([
    "src/client/App.vue",
    "src/client/views/Home.tsx",
    "src/legacy/Widget.jsx",
    "public/index.html",
    "src/pages/index.astro",
    "src/styles/main.css",
    "src/styles/main.scss",
  ])("returns true when a changed file is %s", (path) => {
    expect(hasUiRelevantChangedFile([path])).toBe(true);
  });

  it("is case-insensitive on the extension", () => {
    expect(hasUiRelevantChangedFile(["src/client/App.VUE"])).toBe(true);
  });

  it("returns true when only one of several changed files is UI-relevant", () => {
    expect(
      hasUiRelevantChangedFile(["src/worker/index.ts", "src/client/App.vue"]),
    ).toBe(true);
  });

  it("ignores an extensionless path", () => {
    expect(hasUiRelevantChangedFile(["Dockerfile"])).toBe(false);
  });
});
