import { describe, expect, it } from "vitest";
import { emptyUsageSummary } from "../usage/types";
import { buildChatExportMarkdown } from "./chat-markdown";
import type { ExportMessage } from "./types";

const CHAT = {
  id: "chat-1",
  title: "Trip Planning",
  route: "basic",
  createdAt: "2026-08-01T00:00:00.000Z",
};

const EXPORTED_AT = new Date("2026-08-04T12:00:00.000Z");

describe("buildChatExportMarkdown", () => {
  it("renders the chat's header fields", () => {
    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages: [],
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("# Trip Planning");
    expect(markdown).toContain("- Chat ID: `chat-1`");
    expect(markdown).toContain("- Route: basic");
    expect(markdown).toContain("- Created: 2026-08-01T00:00:00.000Z");
    expect(markdown).toContain("- Exported: 2026-08-04T12:00:00.000Z");
  });

  it("falls back to 'Untitled chat' when the chat has no title yet", () => {
    const markdown = buildChatExportMarkdown({
      chat: { ...CHAT, title: null },
      messages: [],
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("# Untitled chat");
  });

  it("reports 'No turns yet' for a chat with no messages", () => {
    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages: [],
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("_No turns yet._");
  });

  it("renders every message's role label and text, in order", () => {
    const messages: ExportMessage[] = [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "What is the capital of France?" }],
      },
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "Paris." }],
      },
    ];

    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages,
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("## Turn 1 — You");
    expect(markdown).toContain("What is the capital of France?");
    expect(markdown).toContain("## Turn 2 — Agent");
    expect(markdown).toContain("Paris.");
    expect(markdown.indexOf("Turn 1")).toBeLessThan(markdown.indexOf("Turn 2"));
  });

  it("shows a placeholder for a message with no text content", () => {
    const messages: ExportMessage[] = [{ id: "m1", role: "user", parts: [] }];

    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages,
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("_(no text)_");
  });

  it("renders a writeMarkdown tool call and its successful result", () => {
    const messages: ExportMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-writeMarkdown",
            toolCallId: "call-1",
            state: "output-available",
            input: { filename: "notes", content: "hello" },
            output: {
              success: true,
              fileId: "file-1",
              filename: "notes.md",
              sizeBytes: 5,
            },
          },
          { type: "text", text: "Saved your notes." },
        ],
      },
    ];

    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages,
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("**Tool call: writeMarkdown**");
    expect(markdown).toContain("(`output-available`)");
    expect(markdown).toContain('"filename":"notes"');
    expect(markdown).toContain('"success":true');
    expect(markdown).toContain("Saved your notes.");
  });

  it("renders a blocked getUrl outcome, including its error text", () => {
    const messages: ExportMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-getUrl",
            toolCallId: "call-1",
            state: "output-available",
            input: { url: "https://blocked.example" },
            output: {
              success: false,
              blocked: true,
              error: "destination not allowed",
            },
          },
        ],
      },
    ];

    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages,
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("**Tool call: getUrl**");
    expect(markdown).toContain('"blocked":true');
  });

  it("renders a tool call heading with no state suffix when the part carries no state", () => {
    const messages: ExportMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-getUrl",
            toolCallId: "call-1",
            input: { url: "https://example.com" },
          },
        ],
      },
    ];

    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages,
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("**Tool call: getUrl**\n");
    expect(markdown).not.toContain("**Tool call: getUrl** (`");
  });

  it("renders a tool part's own errorText line", () => {
    const messages: ExportMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-getUrl",
            toolCallId: "call-1",
            state: "output-error",
            input: { url: "https://example.com" },
            errorText: "The URL could not be fetched.",
          },
        ],
      },
    ];

    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages,
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("- Error: The URL could not be fetched.");
  });

  it("falls back to String() when a tool part's input/output is not JSON-serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const messages: ExportMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-writeMarkdown",
            toolCallId: "call-1",
            state: "output-available",
            input: circular,
          },
        ],
      },
    ];

    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages,
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("- Input: `[object Object]`");
  });

  it("labels an activate_skill call distinctly as a skill activation (US-11)", () => {
    const messages: ExportMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-activate_skill",
            toolCallId: "call-1",
            state: "output-available",
            input: { name: "cloudflare-spike-fact" },
            output: "Skill instructions loaded.",
          },
        ],
      },
    ];

    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages,
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("**Skill activated:** cloudflare-spike-fact");
    expect(markdown).not.toContain("**Tool call: activate_skill**");
  });

  it("falls back to a generic 'tool' name for a dynamic-tool part with no toolName string", () => {
    const messages: ExportMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "call-1",
            state: "output-available",
            output: "result",
          },
        ],
      },
    ];

    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages,
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("**Tool call: tool**");
  });

  it("labels an activate_skill call as '(unknown)' when its input carries no name", () => {
    const messages: ExportMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool-activate_skill",
            toolCallId: "call-1",
            state: "output-available",
          },
        ],
      },
    ];

    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages,
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("**Skill activated:** (unknown)");
  });

  it("renders a dynamic-tool part using its own toolName field", () => {
    const messages: ExportMessage[] = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "read_skill_resource",
            toolCallId: "call-1",
            state: "output-available",
            input: { path: "reference.md" },
            output: "resource content",
          },
        ],
      },
    ];

    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages,
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("**Tool call: read_skill_resource**");
  });

  it("reports the cost/token summary with a confirmation ratio", () => {
    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages: [],
      usage: {
        totalCostUsd: 0.001234,
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        turnCount: 2,
        confirmedTurnCount: 1,
        lastUpdatedAt: "2026-08-02T00:00:00.000Z",
      },
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain(
      "Total cost: $0.001234 (1 of 2 turns confirmed by AI Gateway)",
    );
    expect(markdown).toContain("Prompt tokens: 100");
    expect(markdown).toContain("Completion tokens: 50");
  });

  it("uses singular 'turn' wording for exactly one turn", () => {
    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages: [],
      usage: {
        totalCostUsd: 0.0001,
        totalPromptTokens: 10,
        totalCompletionTokens: 5,
        turnCount: 1,
        confirmedTurnCount: 1,
        lastUpdatedAt: "2026-08-02T00:00:00.000Z",
      },
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("1 of 1 turn confirmed by AI Gateway");
  });

  it("reports no completed turns yet when the summary is empty", () => {
    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages: [],
      usage: emptyUsageSummary(),
      exportedAt: EXPORTED_AT,
    });

    expect(markdown).toContain("_No completed turns yet._");
  });

  it("defaults exportedAt to the current time when not provided", () => {
    const before = Date.now();
    const markdown = buildChatExportMarkdown({
      chat: CHAT,
      messages: [],
      usage: emptyUsageSummary(),
    });
    const after = Date.now();

    const match = /- Exported: (.+)/u.exec(markdown);
    expect(match).not.toBeNull();
    const exportedAtMs = new Date(match?.[1] ?? "").getTime();
    expect(exportedAtMs).toBeGreaterThanOrEqual(before);
    expect(exportedAtMs).toBeLessThanOrEqual(after);
  });
});
