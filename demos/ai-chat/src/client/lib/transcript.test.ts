import { describe, expect, it } from "vitest";
import type { ChatTurn } from "../stores/chat";
import { buildMarkdownTranscript } from "./transcript";

/** Build a complete `ChatTurn` fixture, overriding only the fields a test cares about. */
function buildTurn(overrides: Partial<ChatTurn> = {}): ChatTurn {
  return {
    id: "turn-1",
    modelId: "@cf/ibm-granite/granite-4.0-h-micro",
    modelDisplayName: "Granite 4.0 H Micro",
    temperature: 0.6,
    maxTokens: 256,
    userContent: "What is the capital of France?",
    answer: "The capital of France is Paris.",
    thinking: "",
    status: "done",
    ttftMs: 120,
    totalMs: 980,
    usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    finishReason: "stop",
    errorDetail: null,
    ...overrides,
  };
}

describe("buildMarkdownTranscript", () => {
  it("renders a placeholder document for an empty conversation", () => {
    const markdown = buildMarkdownTranscript(
      [],
      new Date("2026-07-31T00:00:00.000Z"),
    );

    expect(markdown).toContain("# AI Model Playground Transcript");
    expect(markdown).toContain("Exported: 2026-07-31T00:00:00.000Z");
    expect(markdown).toContain("_No turns yet._");
  });

  it("includes the model, parameters, latency, and usage for a completed turn", () => {
    const markdown = buildMarkdownTranscript(
      [buildTurn()],
      new Date("2026-07-31T00:00:00.000Z"),
    );

    expect(markdown).toContain("## Turn 1");
    expect(markdown).toContain(
      "Model: Granite 4.0 H Micro (`@cf/ibm-granite/granite-4.0-h-micro`)",
    );
    expect(markdown).toContain("Temperature: 0.6");
    expect(markdown).toContain("Max output tokens: 256");
    expect(markdown).toContain("Time to first token: 120 ms");
    expect(markdown).toContain("Total time: 980 ms");
    expect(markdown).toContain("Tokens: 12 prompt / 8 completion / 20 total");
    expect(markdown).toContain("Finish reason: stop");
    expect(markdown).toContain("**You:**");
    expect(markdown).toContain("What is the capital of France?");
    expect(markdown).toContain("**Assistant:**");
    expect(markdown).toContain("The capital of France is Paris.");
  });

  it("renders reasoning text as a collapsible <details> block", () => {
    const markdown = buildMarkdownTranscript([
      buildTurn({ thinking: "First, recall that Paris is the capital." }),
    ]);

    expect(markdown).toContain("<details>");
    expect(markdown).toContain("<summary>Thinking</summary>");
    expect(markdown).toContain("First, recall that Paris is the capital.");
    expect(markdown).toContain("</details>");
  });

  it("omits the thinking block entirely for a turn with no reasoning text", () => {
    const markdown = buildMarkdownTranscript([buildTurn({ thinking: "" })]);

    expect(markdown).not.toContain("<details>");
  });

  it("omits latency, usage, finish reason, and error lines for a fresh streaming turn", () => {
    const markdown = buildMarkdownTranscript([
      buildTurn({
        status: "streaming",
        answer: "",
        ttftMs: null,
        totalMs: null,
        usage: null,
        finishReason: null,
        errorDetail: null,
      }),
    ]);

    expect(markdown).not.toContain("Time to first token");
    expect(markdown).not.toContain("Total time");
    expect(markdown).not.toContain("Tokens:");
    expect(markdown).not.toContain("Finish reason");
    expect(markdown).not.toContain("Error:");
  });

  it("shows a placeholder for a turn with no answer text", () => {
    const markdown = buildMarkdownTranscript([
      buildTurn({ answer: "", status: "stopped", finishReason: "cancelled" }),
    ]);

    expect(markdown).toContain("_(no answer)_");
    expect(markdown).toContain("Finish reason: cancelled");
  });

  it("includes the error detail for a failed turn", () => {
    const markdown = buildMarkdownTranscript([
      buildTurn({
        answer: "",
        status: "error",
        finishReason: null,
        errorDetail: "Workers AI inference failed.",
      }),
    ]);

    expect(markdown).toContain("Error: Workers AI inference failed.");
  });

  it("separates multiple turns with a horizontal rule", () => {
    const markdown = buildMarkdownTranscript([
      buildTurn({ id: "turn-1" }),
      buildTurn({ id: "turn-2", userContent: "And its population?" }),
    ]);

    expect(markdown).toContain("## Turn 1");
    expect(markdown).toContain("## Turn 2");
    expect(markdown).toContain("\n\n---\n\n");
  });
});
