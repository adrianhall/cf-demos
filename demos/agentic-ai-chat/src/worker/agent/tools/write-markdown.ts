import { tool } from "ai";
import { z } from "zod";
import { ChatFilesRepository } from "../../files/repository";
import { chatFileKey, deleteChatFile, putChatFile } from "../../files/storage";
import {
  sanitizeFilename,
  validateMarkdownContent,
} from "../../files/validation";

/**
 * `writeMarkdown` tool (docs/06-AGENTIC-CHAT.md Phase 9, US-8): lets the agent produce a
 * document and have it saved as a real file attached to the chat, rather than leaving it
 * for the user to copy-paste out of the transcript. Zod-validated at the AI SDK level (a
 * malformed tool call never reaches {@link writeMarkdownFile} at all -- the framework itself
 * reports a `tool-input-error` part back over the wire); {@link sanitizeFilename}/
 * {@link validateMarkdownContent} are this module's own *additional* application-level checks
 * a schema alone cannot express (a safe filename charset, a content size cap).
 */
export const writeMarkdownInputSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .describe(
      'A short, descriptive filename for the document, for example "trip-itinerary". A .md extension is added automatically if omitted.',
    ),
  content: z
    .string()
    .min(1)
    .describe("The full document content, formatted as Markdown."),
});

/** Validated input to {@link writeMarkdownFile}. */
export type WriteMarkdownInput = z.infer<typeof writeMarkdownInputSchema>;

/** The tool result returned to the model -- shaped so a failure (Section 11: "never let a tool
 * failure throw an unhandled exception that aborts the whole streaming response") is always a
 * plain, explainable value, never a thrown error. */
export type WriteMarkdownOutput =
  | {
      readonly success: true;
      readonly fileId: string;
      readonly filename: string;
      readonly sizeBytes: number;
    }
  | { readonly success: false; readonly error: string };

/** Collaborators {@link writeMarkdownFile} needs, threaded in by `ChatAgent.onChatMessage()`
 * (`../chat-agent.ts`) rather than imported directly, so this function stays testable with
 * plain fakes instead of real Cloudflare bindings. */
export interface WriteMarkdownDeps {
  /** R2 bucket binding (`FILES`) this tool writes to. */
  readonly bucket: R2Bucket;
  /** D1 capability used to persist this file's metadata. */
  readonly database: Pick<D1Database, "prepare">;
  /** The calling `ChatAgent`'s own instance name -- the chat this file is attached to. */
  readonly chatId: string;
  /** This turn's own correlation UUID (docs/06-AGENTIC-CHAT.md Section 6.6/15) -- the same value
   * `onChatMessage()` already attaches to `chat_usage.correlation_id` (Phase 6), stamped here too
   * so a `chat_files` row can be joined back to the exact turn that produced it (Phase 12's own
   * per-file export), rather than only approximated from timestamps. */
  readonly correlationId: string;
}

/**
 * Sanitize and validate one `writeMarkdown` call's input, then write its content to R2
 * followed by a `chat_files` D1 row -- in that order, deliberately (docs/06-AGENTIC-CHAT.md
 * Section 11): a D1 insert that fails after a successful R2 write leaves an orphaned object,
 * which this function itself compensates for by deleting it, rather than ever leaving a
 * `chat_files` row with no backing object (the reverse ordering, which no compensation could
 * fix after the fact). Every failure path -- an unusable filename, oversized/empty content, an
 * R2 write failure, or a D1 insert failure -- returns a structured {@link WriteMarkdownOutput}
 * failure rather than throwing, so a tool problem never aborts the model's whole turn.
 *
 * @param deps Collaborators (R2 bucket, D1 database, owning chat id).
 * @param input The model's validated tool-call arguments.
 * @returns A success result (the new file's id/filename/size) or a structured failure the model
 * can explain to the user.
 */
export async function writeMarkdownFile(
  deps: WriteMarkdownDeps,
  input: WriteMarkdownInput,
): Promise<WriteMarkdownOutput> {
  const filename = sanitizeFilename(input.filename);
  if (filename === null) {
    return {
      success: false,
      error: "filename must contain at least one letter, digit, or space.",
    };
  }

  let content: string;
  try {
    content = validateMarkdownContent(input.content);
  } catch (error) {
    // `validateMarkdownContent()` only ever throws a plain `Error` (see its own JSDoc) -- no
    // defensive `instanceof` branch this module's own test fixtures could never actually force.
    return { success: false, error: (error as Error).message };
  }

  const fileId = crypto.randomUUID();
  const r2Key = chatFileKey(deps.chatId, fileId);
  const sizeBytes = new TextEncoder().encode(content).byteLength;

  try {
    await putChatFile(deps.bucket, r2Key, content);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "write_markdown_r2_failed",
        chatId: deps.chatId,
        error: String(error),
      }),
    );
    return { success: false, error: "The file could not be stored." };
  }

  try {
    await new ChatFilesRepository(deps.database).create({
      id: fileId,
      chatId: deps.chatId,
      filename,
      r2Key,
      sizeBytes,
      correlationId: deps.correlationId,
    });
  } catch (error) {
    // Compensate for the orphaned R2 object this D1 failure would otherwise leave behind
    // (Section 11) -- best-effort: a failure here is logged, never allowed to mask the
    // original D1 error as the reason this tool call failed.
    await deleteChatFile(deps.bucket, r2Key).catch((cleanupError) => {
      console.error(
        JSON.stringify({
          event: "write_markdown_orphan_cleanup_failed",
          chatId: deps.chatId,
          r2Key,
          error: String(cleanupError),
        }),
      );
    });
    console.error(
      JSON.stringify({
        event: "write_markdown_d1_failed",
        chatId: deps.chatId,
        error: String(error),
      }),
    );
    return { success: false, error: "The file could not be saved." };
  }

  return { success: true, fileId, filename, sizeBytes };
}

/**
 * Build the `writeMarkdown` tool for one turn's `streamText()` call
 * (`ChatAgent.onChatMessage()`), bound to this chat's own R2/D1 bindings.
 *
 * @param deps Collaborators for the built tool's `execute()` function.
 * @returns An `ai` SDK tool, ready to include in `streamText()`'s `tools` option.
 */
export function createWriteMarkdownTool(deps: WriteMarkdownDeps) {
  return tool({
    description:
      "Save a Markdown document as a file attached to this chat, so the user can download it " +
      "later instead of copying it out of the conversation. Use this when the user asks you " +
      "to produce a document, report, note, or other file-shaped content they can keep.",
    inputSchema: writeMarkdownInputSchema,
    execute: (input) => writeMarkdownFile(deps, input),
  });
}
