import type { ModelTier } from "../../../models";
import type { ReviewerRole } from "../roles";
import * as accessibility from "./accessibility";
import * as architecture from "./architecture";
import * as codeQuality from "./code-quality";
import * as security from "./security";

/** One persona's condensed system prompt and assigned model tier -- the two pieces of static
 * metadata `runReviewer.ts` needs for any role. */
export interface ReviewerPersona {
  readonly systemPrompt: string;
  readonly modelTier: ModelTier;
}

/**
 * The four reviewer personas, keyed by role (docs/07-PR-REVIEW-AGENT.md, "Reviewer Personas And
 * Structured Findings"'s table). One module per role (`./architecture.ts`, `./security.ts`,
 * `./code-quality.ts`, `./accessibility.ts`) so each persona's prompt stays independently
 * readable/reviewable; this registry is the single place they are assembled by role for
 * `runReviewer.ts` and `ReviewPipelineWorkflow.ts` to look up.
 */
export const PERSONAS: Record<ReviewerRole, ReviewerPersona> = {
  architecture: {
    systemPrompt: architecture.SYSTEM_PROMPT,
    modelTier: architecture.MODEL_TIER,
  },
  security: {
    systemPrompt: security.SYSTEM_PROMPT,
    modelTier: security.MODEL_TIER,
  },
  "code-quality": {
    systemPrompt: codeQuality.SYSTEM_PROMPT,
    modelTier: codeQuality.MODEL_TIER,
  },
  accessibility: {
    systemPrompt: accessibility.SYSTEM_PROMPT,
    modelTier: accessibility.MODEL_TIER,
  },
};
