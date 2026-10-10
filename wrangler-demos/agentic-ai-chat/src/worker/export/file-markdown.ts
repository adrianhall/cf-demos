/**
 * @file Builds the per-file Markdown export `../routes/chats.ts`'s
 * `GET /:id/files/:fileId/export` downloads (docs/06-AGENTIC-CHAT.md Phase 12, US-11): wraps
 * one `writeMarkdown`-generated file's own content with the cost/token context of the turn that
 * produced it. Kept as a pure function, mirroring `./chat-markdown.ts`'s own split from its
 * HTTP route -- the caller has already joined `chat_files.correlation_id` back to that turn's
 * `chat_usage` row (Section 6.4/15's resolved open question) before ever calling this.
 */
import type { ChatUsageRow } from "../usage/types";

/** Input to {@link buildFileExportMarkdown}. */
export interface FileExportInput {
  /** The file's already-sanitized filename (`../files/validation.ts`'s `sanitizeFilename()`). */
  readonly filename: string;
  /** The file's raw Markdown content, read back from R2 (`../files/storage.ts`'s
   * `getChatFile()`). */
  readonly content: string;
  /** The owning chat's own auto-generated title, or `null` before its first turn completes --
   * used in the header, falling back to {@link chatId} when absent. */
  readonly chatTitle: string | null;
  /** The owning chat's id. */
  readonly chatId: string;
  /** The `chat_usage` row for the turn that produced this file (`../usage/repository.ts`'s
   * `UsageRepository.findByCorrelationId()`), or `null` if no such row could be found --
   * tolerated the same way a disappeared reconciliation target is tolerated elsewhere in this
   * demo (Section 11): this export still succeeds, just without a cost/token breakdown. */
  readonly usage: ChatUsageRow | null;
  /** Timestamp recorded in the document header. Defaults to the current time; accepting it as
   * a parameter keeps this function deterministic and easy to test, mirroring
   * `./chat-markdown.ts`'s own `exportedAt` parameter. */
  readonly exportedAt?: Date;
}

/** Render the producing turn's cost/token context, or an explanatory placeholder when no
 * `chat_usage` row could be found for this file's correlation id. */
function formatUsage(usage: ChatUsageRow | null): string {
  if (usage === null) {
    return "_Cost context for the turn that produced this file is no longer available._";
  }
  const sourceLabel =
    usage.costSource === "gateway" ? "AI Gateway-confirmed" : "Estimated";
  return [
    `- Model: ${usage.model}`,
    `- Cost: $${usage.costUsd.toFixed(6)} (${sourceLabel})`,
    `- Prompt tokens: ${usage.promptTokens}`,
    `- Completion tokens: ${usage.completionTokens}`,
  ].join("\n");
}

/**
 * Build the complete Markdown document for a single generated file's export
 * (docs/06-AGENTIC-CHAT.md Phase 12, US-11): a header naming the file and its owning chat, the
 * producing turn's cost/token context, and the file's own content verbatim below a horizontal
 * rule.
 *
 * @param input The file's content/metadata and its producing turn's usage row, if found.
 * @returns The complete Markdown document as a single string.
 */
export function buildFileExportMarkdown(input: FileExportInput): string {
  const exportedAt = input.exportedAt ?? new Date();
  const header = [
    `# ${input.filename}`,
    "",
    `- Chat: ${input.chatTitle ?? input.chatId}`,
    `- Exported: ${exportedAt.toISOString()}`,
    "",
    "## Cost Context Of The Producing Turn",
    "",
    formatUsage(input.usage),
    "",
    "---",
    "",
  ];
  return `${header.join("\n")}\n${input.content}\n`;
}
