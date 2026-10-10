import { z } from "zod";

/**
 * A single reviewer's own structured finding, exactly as it appears in that reviewer's fenced
 * `json` block (docs/07-PR-REVIEW-AGENT.md, "Reviewer Personas And Structured Findings"). Every
 * `findingRef` is only unique within its own reviewer's output -- `../merge.ts` is what makes
 * refs unique across a whole run.
 */
export const RawFindingSchema = z.object({
  findingRef: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.string().min(1),
  filePath: z.string().nullable(),
  lineNumber: z.number().int().nullable(),
  finding: z.string().min(1),
  recommendation: z.string().min(1),
});

/** A single reviewer's own structured finding (see {@link RawFindingSchema}). */
export type RawFinding = z.infer<typeof RawFindingSchema>;

const RawFindingArraySchema = z.array(RawFindingSchema);

/** Matches every fenced code block in a model's reply, capturing its inner text -- the
 * `json` language tag is optional since a model does not always include it despite being asked
 * to (`s` flag so `.` also matches newlines inside the block). */
const FENCED_BLOCK_PATTERN = /```(?:json)?\s*\n?([\s\S]*?)```/g;

/**
 * Extract the LAST fenced code block from a model's raw reply, `JSON.parse()` it, and validate
 * it as a {@link RawFinding} array (docs/07-PR-REVIEW-AGENT.md, "Reviewer Personas And
 * Structured Findings": "Parse the fenced block and validate it with a `zod` schema"). Taking
 * the *last* block (not the first) tolerates a model that fenced an earlier illustrative example
 * before its real answer.
 *
 * Never swallows a failure -- always throws a descriptive `Error` so `./runReviewer.ts`'s
 * bounded one-shot repair retry has a real message to hand back to the model.
 *
 * @param rawOutput The model's full text reply for one turn.
 * @returns The validated findings array.
 * @throws {Error} When no fenced block is present, the block's contents are not valid JSON, or
 * the parsed JSON does not match the {@link RawFinding} array schema.
 */
export function parseFencedFindings(rawOutput: string): RawFinding[] {
  const blocks = [...rawOutput.matchAll(FENCED_BLOCK_PATTERN)];
  const lastBlock = blocks.at(-1);
  if (!lastBlock) {
    throw new Error(
      "No fenced code block found in the model's output -- expected exactly one fenced `json` " +
        "block containing the findings array.",
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(lastBlock[1] ?? "");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Fenced block content is not valid JSON: ${message}`);
  }

  const result = RawFindingArraySchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(
      `Fenced block's JSON does not match the expected findings array shape: ${result.error.message}`,
    );
  }
  return result.data;
}
