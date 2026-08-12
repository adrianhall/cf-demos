import { tool } from "ai";
import { z } from "zod";
import type { GitProviderClient, PrReference } from "../providers/types";

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "The repository-relative file path to read, exactly as it appears in the diff's changed-file list (for example 'src/worker/routes/orders.ts').",
    ),
});

/** What {@link createGetFileContentTool}'s tool returns to the model -- either the file's
 * (possibly truncated) content, or a short explanation of why it could not be read. Kept as a
 * plain JSON-serializable object (never `null`/`undefined`) so every Workers AI model's tool-
 * result handling sees a consistent shape regardless of outcome. */
interface GetFileContentToolOutput {
  readonly content: string | null;
  readonly truncated: boolean;
  readonly error: string | null;
}

/**
 * Build the one tool every reviewer persona gets (docs/07-PR-REVIEW-AGENT.md, "Reviewer Personas
 * And Structured Findings": "Every reviewer gets the same one tool"), wrapping
 * {@link GitProviderClient.getFileContent} for a specific run's PR/MR. A factory function
 * (rather than a bare tool constant) so a test can substitute a fake `client`/`ref` with no
 * network access, and so each `runReviewer()` call gets a tool bound to the correct run.
 *
 * @param client The provider client to read files through.
 * @param ref The PR/MR whose head commit files should be read.
 * @returns An `ai` SDK tool definition, passed to `generateText()`'s `tools` option
 * (`./runReviewer.ts`).
 */
export function createGetFileContentTool(
  client: GitProviderClient,
  ref: PrReference,
) {
  return tool({
    description:
      "Read the current content of one file in this PR/MR's repository, at its head commit, " +
      "for context beyond what the diff hunk shows. Only reads files that already exist in " +
      "this PR/MR's own repository -- it cannot read an arbitrary path outside it.",
    inputSchema,
    execute: async ({ path }): Promise<GetFileContentToolOutput> => {
      const result = await client.getFileContent(ref, path);
      if (result === null) {
        return {
          content: null,
          truncated: false,
          error: `Could not read "${path}" -- the provider returned no content for this path at this PR/MR's head commit.`,
        };
      }
      return {
        content: result.content,
        truncated: result.truncated,
        error: null,
      };
    },
  });
}
