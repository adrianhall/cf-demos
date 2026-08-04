/**
 * @file Builds the full-chat Markdown transcript `../routes/chats.ts`'s `GET /:id/export`
 * downloads (docs/06-AGENTIC-CHAT.md Phase 12, US-11): every turn, every tool call/result
 * (including skill activations), and the chat's own cost/token summary
 * (`../usage/types.ts`'s `ChatUsageSummary`, Section 6.6). Kept as a pure function of already-
 * fetched data, separate from the HTTP route that fetches that data (this chat's persisted
 * messages via its `ChatAgent` Durable Object, and its usage aggregate from D1) -- mirroring
 * `demos/ai-chat/src/client/lib/transcript.ts`'s own "formatting is a pure, unit-testable
 * function" split, applied here server-side rather than client-side, since (unlike demo 5) this
 * chat's transcript and cost ledger are both durable server-side state, not already sitting in
 * the browser's memory to format (docs/06-AGENTIC-CHAT.md Phase 12, task 1's own rationale).
 */
import type { ChatUsageSummary } from "../usage/types";
import type { ExportMessage, ExportMessagePart } from "./types";

/** The chat directory fields this builder needs -- a subset of `../chats/types.ts`'s `Chat`,
 * accepted structurally rather than by importing the whole shape, since this module has no use
 * for {@link import("../chats/types").Chat.ownerEmail}/`updatedAt`. */
export interface ChatExportChatInfo {
  /** The chat's own id, used in the header and as a filename fallback when {@link title} is
   * `null`. */
  readonly id: string;
  /** The chat's auto-generated title, or `null` before its first turn completes. */
  readonly title: string | null;
  /** The chat's selected governed model route (docs/06-AGENTIC-CHAT.md Phase 4, US-3). */
  readonly route: string;
  /** ISO 8601 timestamp of chat creation. */
  readonly createdAt: string;
}

/** Input to {@link buildChatExportMarkdown}. */
export interface ChatExportInput {
  /** The chat's own directory metadata. */
  readonly chat: ChatExportChatInfo;
  /** The chat's full persisted transcript, oldest first (`AIChatAgent`'s own `get-messages`
   * response, forwarded by `../routes/chats.ts`). */
  readonly messages: readonly ExportMessage[];
  /** The chat's current cost/token totals (`../usage/repository.ts`'s
   * `UsageRepository.aggregateForChat()`). */
  readonly usage: ChatUsageSummary;
  /** Timestamp recorded in the document header. Defaults to the current time; accepting it as
   * a parameter keeps this function deterministic and easy to test, mirroring
   * `demos/ai-chat/src/client/lib/transcript.ts`'s `buildMarkdownTranscript()`. */
  readonly exportedAt?: Date;
}

/**
 * Resolve a tool-call part's tool name, or `null` for a part this export does not treat as a
 * tool call at all (a plain `"text"` part, a reasoning/step-boundary part).
 *
 * @param part The message part to inspect.
 * @returns The tool's name, or `null` if `part` is not a tool-call part.
 */
function resolveToolName(part: ExportMessagePart): string | null {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" ? part.toolName : "tool";
  }
  return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : null;
}

/** `JSON.stringify()` a tool part's `input`/`output`, falling back to `String()` for a value
 * that (in principle) is not JSON-serializable -- defensive only; every tool this demo ships
 * (`writeMarkdown`/`getUrl`/`agents/skills`'s own tools) always carries a plain, serializable
 * value here. */
function formatJsonValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Render one tool-call part as a Markdown bullet (plus indented detail lines), specially
 * labeling `activate_skill` as a skill activation per US-11's own acceptance criterion ("tool
 * calls and their results including skill activations") -- every other tool renders through the
 * same generic shape, so a future tool this demo adds still exports legibly with no exporter
 * change required.
 *
 * @param part A tool-call part.
 * @param name This part's own tool name, already resolved by the caller (`resolveToolName()`) --
 * accepted rather than re-derived here, so this function has no "not a tool call after all"
 * branch of its own to keep reachable; `formatMessage()`'s own filter is the only place that
 * decision is made.
 * @returns One or more Markdown lines describing this tool call.
 */
function formatToolPart(part: ExportMessagePart, name: string): string {
  if (name === "activate_skill") {
    const skillName = (part.input as { name?: unknown } | undefined)?.name;
    return `- **Skill activated:** ${typeof skillName === "string" ? skillName : "(unknown)"}`;
  }
  const lines = [
    `- **Tool call: ${name}**${part.state ? ` (\`${part.state}\`)` : ""}`,
  ];
  if (part.input !== undefined) {
    lines.push(`  - Input: \`${formatJsonValue(part.input)}\``);
  }
  if (part.output !== undefined) {
    lines.push(`  - Result: \`${formatJsonValue(part.output)}\``);
  }
  if (part.errorText) {
    lines.push(`  - Error: ${part.errorText}`);
  }
  return lines.join("\n");
}

/** Concatenate every `"text"` part's text -- mirrors `useChatAgent.ts`'s own `extractText()`,
 * this module's server-side equivalent. */
function extractText(parts: readonly ExportMessagePart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/** Render one persisted message as a Markdown section: its role-labeled heading, its text
 * content, and every tool call it carries (US-11's "tool calls and their results" requirement).
 * Each message -- not each user/assistant round trip -- gets its own numbered "Turn", matching
 * how this demo's own client (`useChatAgent.ts`'s `ChatTurn[]`) already numbers turns. */
function formatMessage(message: ExportMessage, index: number): string {
  const roleLabel = message.role === "assistant" ? "Agent" : "You";
  const text = extractText(message.parts);
  const toolLines = message.parts
    .map((part) => {
      const name = resolveToolName(part);
      return name === null ? null : formatToolPart(part, name);
    })
    .filter((line): line is string => line !== null);

  const lines = [
    `## Turn ${index + 1} — ${roleLabel}`,
    "",
    text.length > 0 ? text : "_(no text)_",
  ];
  if (toolLines.length > 0) {
    lines.push("", ...toolLines);
  }
  return lines.join("\n");
}

/** Render this chat's cost/token totals, distinguishing an AI-Gateway-confirmed figure from a
 * still-estimated one exactly like `UsageBadge.vue`'s own confirmation-ratio readout (Section
 * 6.6a) -- US-11's own acceptance criterion ("a cost/token summary") never presents a number of
 * ambiguous provenance. */
function formatCostSummary(usage: ChatUsageSummary): string {
  if (usage.turnCount === 0) {
    return "_No completed turns yet._";
  }
  const turnWord = usage.turnCount === 1 ? "turn" : "turns";
  return [
    `- Total cost: $${usage.totalCostUsd.toFixed(6)} (${usage.confirmedTurnCount} of ${usage.turnCount} ${turnWord} confirmed by AI Gateway)`,
    `- Prompt tokens: ${usage.totalPromptTokens}`,
    `- Completion tokens: ${usage.totalCompletionTokens}`,
  ].join("\n");
}

/**
 * Build the complete Markdown document for a full chat export (docs/06-AGENTIC-CHAT.md Phase
 * 12, US-11): a header (title, id, route, timestamps), the chat's cost/token summary, and every
 * turn in order, including its tool calls/results and any skill activations.
 *
 * @param input The chat's directory metadata, full persisted transcript, and current usage
 * aggregate.
 * @returns The complete Markdown document as a single string.
 */
export function buildChatExportMarkdown(input: ChatExportInput): string {
  const exportedAt = input.exportedAt ?? new Date();
  const header = [
    `# ${input.chat.title ?? "Untitled chat"}`,
    "",
    `- Chat ID: \`${input.chat.id}\``,
    `- Route: ${input.chat.route}`,
    `- Created: ${input.chat.createdAt}`,
    `- Exported: ${exportedAt.toISOString()}`,
    "",
    "## Cost And Token Summary",
    "",
    formatCostSummary(input.usage),
    "",
  ];
  if (input.messages.length === 0) {
    return `${header.join("\n")}\n_No turns yet._\n`;
  }
  const sections = input.messages.map((message, index) =>
    formatMessage(message, index),
  );
  return `${header.join("\n")}\n${sections.join("\n\n---\n\n")}\n`;
}
