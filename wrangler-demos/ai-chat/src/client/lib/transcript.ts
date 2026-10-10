/**
 * @file Builds the Markdown transcript downloaded by the Export control. Kept as a pure function
 * of {@link ChatTurn}s, separate from the browser download trigger in `./download.ts`, so the
 * formatting itself is unit-testable without touching the DOM (see docs/05-AI-CHAT.md, Phase 4,
 * task 21).
 */
import type { ChatTurn } from "../stores/chat";

/** Render one turn's parameters and, once known, its latency/usage footer as Markdown bullets. */
function formatTurnMeta(turn: ChatTurn): string {
  const lines = [
    `- Model: ${turn.modelDisplayName} (\`${turn.modelId}\`)`,
    `- Temperature: ${turn.temperature}`,
    `- Max output tokens: ${turn.maxTokens}`,
    `- Status: ${turn.status}`,
  ];
  if (turn.ttftMs !== null) {
    lines.push(`- Time to first token: ${turn.ttftMs} ms`);
  }
  if (turn.totalMs !== null) {
    lines.push(`- Total time: ${turn.totalMs} ms`);
  }
  if (turn.usage !== null) {
    lines.push(
      `- Tokens: ${turn.usage.promptTokens} prompt / ${turn.usage.completionTokens} completion / ` +
        `${turn.usage.totalTokens} total`,
    );
  }
  if (turn.finishReason !== null) {
    lines.push(`- Finish reason: ${turn.finishReason}`);
  }
  if (turn.errorDetail !== null) {
    lines.push(`- Error: ${turn.errorDetail}`);
  }
  return lines.join("\n");
}

/** Render one turn as a Markdown section: its metadata, the user's message, and the answer. */
function formatTurn(turn: ChatTurn, index: number): string {
  const lines = [
    `## Turn ${index + 1}`,
    "",
    formatTurnMeta(turn),
    "",
    "**You:**",
    "",
    turn.userContent,
  ];

  // Only a turn that actually produced reasoning text gets a Thinking block — a turn from a
  // `reasoning: "none"` model, or one stopped/failed before any reasoning arrived, has nothing
  // to show here.
  if (turn.thinking.length > 0) {
    lines.push(
      "",
      "<details>",
      "<summary>Thinking</summary>",
      "",
      turn.thinking,
      "",
      "</details>",
    );
  }

  lines.push(
    "",
    "**Assistant:**",
    "",
    turn.answer.length > 0 ? turn.answer : "_(no answer)_",
  );
  return lines.join("\n");
}

/**
 * Build the full Markdown transcript for a conversation, per docs/05-AI-CHAT.md's Export
 * requirement: every turn's model, parameters, latency, token usage, and thinking section
 * (as a collapsible `<details>` block).
 *
 * @param turns The conversation to export, in chronological order.
 * @param exportedAt Timestamp recorded in the document header. Defaults to the current time;
 * accepting it as a parameter keeps this function deterministic and easy to test.
 * @returns The complete Markdown document as a single string.
 */
export function buildMarkdownTranscript(
  turns: readonly ChatTurn[],
  exportedAt: Date = new Date(),
): string {
  const header = [
    "# AI Model Playground Transcript",
    "",
    `Exported: ${exportedAt.toISOString()}`,
    "",
  ];
  if (turns.length === 0) {
    return `${header.join("\n")}\n_No turns yet._\n`;
  }
  const sections = turns.map((turn, index) => formatTurn(turn, index));
  return `${header.join("\n")}\n${sections.join("\n\n---\n\n")}\n`;
}
