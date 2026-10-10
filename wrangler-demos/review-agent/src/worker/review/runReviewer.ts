import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { modelIdForTier } from "../../models";
import type { GitProviderClient, PrReference } from "../providers/types";
import { createGetFileContentTool } from "./getFileContentTool";
import { withOutputContract } from "./outputContract";
import { PERSONAS } from "./personas";
import type { ReviewerRole } from "./roles";
import { parseFencedFindings, type RawFinding } from "./schema";

/**
 * Thrown when a reviewer's output still fails to parse as valid findings JSON after the one
 * bounded corrective retry (docs/07-PR-REVIEW-AGENT.md, "Reviewer Personas And Structured
 * Findings"). Distinguishable from every other error `runReviewer()` can throw (a network error,
 * a Workers AI error) so `ReviewPipelineWorkflow`'s `review:<role>` step can convert this
 * specific failure into a `NonRetryableError` -- repeating an already-uncooperative model's exact
 * same prompt a third and fourth time is unlikely to help and would otherwise mean paying for
 * up to three near-identical failed calls instead of one (Implementation Plan Phase 4, item 17).
 */
export class ReviewerJsonInvalidError extends Error {
  constructor(role: ReviewerRole, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Reviewer "${role}"'s output could not be parsed as valid findings JSON, even after one ` +
        `corrective retry: ${causeMessage}`,
    );
    this.name = "ReviewerJsonInvalidError";
  }
}

/** Input to {@link runReviewer}. */
export interface RunReviewerInput {
  /** Which persona/model tier to run (`./personas/index.ts`). */
  readonly role: ReviewerRole;
  /** The PR/MR this review is for -- passed to the `getFileContent` tool. */
  readonly ref: PrReference;
  /** The capped, concatenated unified diff (`GitProviderClient.fetchDiff()`'s own result). */
  readonly diff: string;
  /** The capped changed-file list, shown to the model alongside the diff for orientation. */
  readonly changedFiles: readonly string[];
  /** The provider client the `getFileContent` tool reads through. */
  readonly client: GitProviderClient;
  /** The `env.AI` Workers AI binding. Typed as the ambient global `Ai` interface (not imported
   * -- `worker-configuration.d.ts` declares it globally) so a test can substitute any object
   * structurally matching the one method (`run`) and one property (`aiGatewayLogId`) this
   * function actually uses. */
  readonly ai: Ai;
  /** The AI Gateway id every call is routed through (`env.AI_GATEWAY_ID`). */
  readonly gatewayId: string;
}

/** The result of {@link runReviewer}. */
export interface RunReviewerResult {
  /** This reviewer's own validated findings. */
  readonly findings: RawFinding[];
  /** The exact text of whichever turn's output ultimately parsed successfully (the first turn,
   * or the one corrective-retry turn) -- for the full report's per-reviewer raw-output section. */
  readonly rawOutput: string;
  /** AI Gateway's own logged id for the call that produced {@link rawOutput}, or `null` if the
   * binding did not populate one. See this module's own comment at the read site for exactly
   * which mechanism populates it and why. */
  readonly aiGatewayLogId: string | null;
}

/**
 * Build the user turn shown to a reviewer persona: the changed-file list (for quick orientation)
 * followed by the capped unified diff.
 */
function buildUserPrompt(
  diff: string,
  changedFiles: readonly string[],
): string {
  const fileList = changedFiles.map((path) => `- ${path}`).join("\n");
  return (
    `Changed files (${changedFiles.length}):\n${fileList}\n\n` +
    `Unified diff:\n\`\`\`diff\n${diff}\n\`\`\`\n\n` +
    "Use the getFileContent tool if you need more context than a diff hunk shows -- for example " +
    "to see a function's full body or a neighboring file. Follow the output contract in your " +
    "system prompt exactly: prose first, then exactly one fenced `json` block as the very last " +
    "thing in your reply."
  );
}

/**
 * Run one reviewer persona against one PR/MR's diff: a `generateText()` turn with the shared
 * `getFileContent` tool, a bounded tool-call budget, and one bounded corrective retry if the
 * model's fenced JSON does not parse (docs/07-PR-REVIEW-AGENT.md, "Reviewer Personas And
 * Structured Findings").
 *
 * Deliberately makes no D1 writes and does no Workflow-step bookkeeping of its own -- it is a
 * pure function of its inputs (aside from the two network calls it makes), called from inside
 * `ReviewPipelineWorkflow`'s own `review:<role>` step, which is what actually persists the
 * result.
 *
 * @param input See {@link RunReviewerInput}.
 * @returns See {@link RunReviewerResult}.
 * @throws {ReviewerJsonInvalidError} When the model's output still fails to parse after the one
 * corrective retry.
 */
export async function runReviewer(
  input: RunReviewerInput,
): Promise<RunReviewerResult> {
  const persona = PERSONAS[input.role];
  const modelId = modelIdForTier(persona.modelTier);
  const workersai = createWorkersAI({ binding: input.ai });
  const model = workersai(modelId, { gateway: { id: input.gatewayId } });
  const tools = {
    getFileContent: createGetFileContentTool(input.client, input.ref),
  };
  const system = withOutputContract(persona.systemPrompt);
  const userPrompt = buildUserPrompt(input.diff, input.changedFiles);

  const first = await generateText({
    model,
    system,
    messages: [{ role: "user", content: userPrompt }],
    tools,
    stopWhen: stepCountIs(4),
  });
  // `env.AI.aiGatewayLogId` is a mutable side channel the binding itself updates after every
  // `run()`/provider call through it -- there is no field on `generateText()`'s own result
  // (`GenerateTextResult`'s `providerMetadata`/`response` do not carry it for this provider) that
  // exposes AI Gateway's logged id for a call. Reading it immediately after each `generateText()`
  // call, before any other call reuses the same binding instance, is the mechanism
  // docs/DECISIONS.md #13 confirms actually populates for a literal model id (as opposed to a
  // dynamic route, which nulls it out unconditionally). Reviewers run strictly sequentially
  // within one Workflow step (never concurrently against the same `Ai` instance), so there is no
  // race between this read and a different reviewer's own call overwriting the same property.
  const firstLogId = input.ai.aiGatewayLogId;

  try {
    const findings = parseFencedFindings(first.text);
    return { findings, rawOutput: first.text, aiGatewayLogId: firstLogId };
  } catch (firstError) {
    const repairMessage =
      firstError instanceof Error ? firstError.message : String(firstError);
    const repair = await generateText({
      model,
      system,
      messages: [
        { role: "user", content: userPrompt },
        { role: "assistant", content: first.text },
        {
          role: "user",
          content:
            `Your last response's JSON was invalid: ${repairMessage}. Return ONLY the ` +
            "corrected JSON array, no prose.",
        },
      ],
      tools,
      stopWhen: stepCountIs(4),
    });
    const repairLogId = input.ai.aiGatewayLogId;

    try {
      const findings = parseFencedFindings(repair.text);
      return { findings, rawOutput: repair.text, aiGatewayLogId: repairLogId };
    } catch (repairError) {
      throw new ReviewerJsonInvalidError(input.role, repairError);
    }
  }
}
