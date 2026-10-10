import { describe, expect, it } from "vitest";
import { buildFileExportMarkdown } from "./file-markdown";

const EXPORTED_AT = new Date("2026-08-04T12:00:00.000Z");

describe("buildFileExportMarkdown", () => {
  it("renders the file's header, cost context, and content verbatim", () => {
    const markdown = buildFileExportMarkdown({
      filename: "trip-itinerary.md",
      content: "# Trip\n\nPack sunscreen.",
      chatTitle: "Trip Planning",
      chatId: "chat-1",
      usage: {
        id: "usage-1",
        chatId: "chat-1",
        model: "@cf/zai-org/glm-5.2",
        promptTokens: 40,
        completionTokens: 80,
        costUsd: 0.000_412,
        costSource: "gateway",
        correlationId: "corr-1",
        gatewayLogId: "log-1",
        reconcileAttempts: 1,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:10.000Z",
      },
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("# trip-itinerary.md");
    expect(markdown).toContain("- Chat: Trip Planning");
    expect(markdown).toContain("- Exported: 2026-08-04T12:00:00.000Z");
    expect(markdown).toContain("- Model: @cf/zai-org/glm-5.2");
    expect(markdown).toContain("- Cost: $0.000412 (AI Gateway-confirmed)");
    expect(markdown).toContain("- Prompt tokens: 40");
    expect(markdown).toContain("- Completion tokens: 80");
    expect(markdown).toContain("# Trip\n\nPack sunscreen.");
  });

  it("labels a still-estimated figure distinctly from a confirmed one", () => {
    const markdown = buildFileExportMarkdown({
      filename: "notes.md",
      content: "hello",
      chatTitle: null,
      chatId: "chat-1",
      usage: {
        id: "usage-1",
        chatId: "chat-1",
        model: "@cf/google/gemma-4-26b-a4b-it",
        promptTokens: 5,
        completionTokens: 5,
        costUsd: 0.000_001,
        costSource: "estimated",
        correlationId: "corr-1",
        gatewayLogId: null,
        reconcileAttempts: 0,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      },
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("(Estimated)");
    expect(markdown).not.toContain("AI Gateway-confirmed");
  });

  it("falls back to the chat id in the header when the chat has no title yet", () => {
    const markdown = buildFileExportMarkdown({
      filename: "notes.md",
      content: "hello",
      chatTitle: null,
      chatId: "chat-1",
      usage: null,
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("- Chat: chat-1");
  });

  it("renders an explanatory placeholder when no usage row could be found", () => {
    const markdown = buildFileExportMarkdown({
      filename: "notes.md",
      content: "hello",
      chatTitle: "Notes",
      chatId: "chat-1",
      usage: null,
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain(
      "_Cost context for the turn that produced this file is no longer available._",
    );
  });

  it("defaults exportedAt to the current time when not provided", () => {
    const before = Date.now();
    const markdown = buildFileExportMarkdown({
      filename: "notes.md",
      content: "hello",
      chatTitle: "Notes",
      chatId: "chat-1",
      usage: null,
    });
    const after = Date.now();

    const match = /- Exported: (.+)/u.exec(markdown);
    expect(match).not.toBeNull();
    const exportedAtMs = new Date(match?.[1] ?? "").getTime();
    expect(exportedAtMs).toBeGreaterThanOrEqual(before);
    expect(exportedAtMs).toBeLessThanOrEqual(after);
  });
});
