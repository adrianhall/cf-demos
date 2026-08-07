import { architectureProposalJsonSchema } from "../../graph/proposal";
import { FixtureArchitectureGenerator } from "./fixtures";

/**
 * The verified Workers AI model selected in `spikes/09-architect-ai-structured-output/REPORT.md`.
 * Do not substitute a different model without a fresh deployed spike — Spike 10's own "Phase 5
 * corrections" section records that Workers AI model availability changes over time and an
 * unqualified/deprecated model id fails outright.
 */
export const ARCHITECTURE_MODEL =
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

/** Maximum tokens requested from the model — enough for a 2-8 node/0-10 edge JSON proposal. */
const MAX_RESPONSE_TOKENS = 800;

/** Input `ArchitectureWorkflow`'s `generate` step passes to {@link ArchitectureGenerator.generate}. */
export interface ArchitectureGeneratorRequest {
  /** The requester's short natural-language application description. */
  prompt: string;
  /** The `summarize` step's compact catalog + current-diagram summary (`../architecture/summary.ts`). */
  catalogSummary: string;
  /**
   * 1-indexed Workflow step attempt number (`WorkflowStepContext.attempt`). Logged, never used
   * to alter production behavior — the `"transient-then-success"` test fixture is the only
   * caller that inspects it.
   */
  attempt: number;
}

/**
 * The generation seam `ArchitectureWorkflow`'s `generate` step calls through, matching Spike 08's
 * measured `generate({ fixture, attempt, summary }) => raw text` interface adapted to this
 * phase's real feature: `fixture` is replaced by the actual user `prompt`, since this is no
 * longer a fixture-only spike. Implementations return raw text; parsing and
 * schema/catalog validation happen once, on the Workflow side
 * (`../architecture-workflow.ts`'s `validate` step), never inside a generator implementation.
 */
export interface ArchitectureGenerator {
  /**
   * Produce one raw-text architecture proposal candidate.
   *
   * @param request The prompt, catalog summary, and current attempt number.
   * @returns Raw text — expected, but not guaranteed, to be JSON matching
   * `../../graph/proposal.ts`'s `ArchitectureProposal` shape. The caller must independently
   * validate it.
   */
  generate(request: ArchitectureGeneratorRequest): Promise<string>;
}

/**
 * Build the fixed system instruction sent alongside the user's prompt, describing the curated
 * catalog and current diagram context. Never includes anything from a different diagram or
 * requester than the one this Workflow instance was started for.
 *
 * @param catalogSummary The `summarize` step's own summary text.
 * @returns The system message content.
 */
function buildSystemPrompt(catalogSummary: string): string {
  return [
    "You are an assistant that proposes a Cloudflare architecture diagram as JSON matching the",
    "provided schema. Use only the listed catalog product ids for product nodes. Propose between",
    "2 and 8 nodes and at most 10 edges. Do not include any text outside the JSON object.",
    "",
    catalogSummary,
  ].join("\n");
}

/**
 * Extract the raw text payload from a `@cf/meta/llama-3.3-70b-instruct-fp8-fast` response,
 * matching the response shape observed in
 * `spikes/09-architect-ai-structured-output/REPORT.md` ("wrapper: `response`; payload: `title`,
 * `nodes`, `edges`").
 *
 * @param output The value returned by `env.AI.run()`.
 * @returns The raw text payload.
 * @throws {Error} When `output` does not match any known response shape — for example an async
 * batch response, which this generator never requests.
 */
function extractResponseText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (typeof output === "object" && output !== null && "response" in output) {
    const { response } = output as { response: unknown };
    if (typeof response === "string") {
      return response;
    }
    // A deployed smoke test (`docs/09-ARCHITECT.md`'s Phase 5 completion requirement) observed
    // that `response_format: { type: "json_schema", ... }` returns `response` as an
    // already-parsed object matching the schema, not a raw JSON string — Spike 09's own report
    // phrased this as "payload: `title`, `nodes`, `edges`" without spelling out that distinction.
    // Re-serialize it so this generator's contract (`ArchitectureGenerator.generate` returns raw
    // text) stays uniform regardless of which shape a given model/adapter combination returns;
    // the Workflow's `validate` step always calls `JSON.parse()` on the result either way.
    if (response !== null && typeof response === "object") {
      return JSON.stringify(response);
    }
  }
  throw new Error("Workers AI returned an unsupported response shape.");
}

/**
 * Real {@link ArchitectureGenerator} implementation, calling the verified Workers AI model
 * through `response_format`'s `json_schema` adapter (`spikes/09-architect-ai-structured-output/REPORT.md`'s
 * measured decision — `guided_json` is not the selected adapter).
 */
export class WorkersAiArchitectureGenerator implements ArchitectureGenerator {
  /** @param ai The `AI` binding. */
  constructor(private readonly ai: Pick<Ai, "run">) {}

  async generate(request: ArchitectureGeneratorRequest): Promise<string> {
    const output = await this.ai.run(ARCHITECTURE_MODEL, {
      messages: [
        { role: "system", content: buildSystemPrompt(request.catalogSummary) },
        { role: "user", content: request.prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: architectureProposalJsonSchema,
      },
      max_tokens: MAX_RESPONSE_TOKENS,
      temperature: 0,
    });
    return extractResponseText(output);
  }
}

/**
 * Select the {@link ArchitectureGenerator} implementation `ArchitectureWorkflow` uses.
 *
 * Selects {@link FixtureArchitectureGenerator} only when `env.ENVIRONMENT === "test"` (set by
 * `tests/integration/vitest.config.ts`'s `miniflare.bindings`, the same binding
 * `@adrianhall/cloudflare-toolkit/logging`'s `resolveLoggerConfig` already keys off) so every
 * automated test can exercise every generator outcome without ever calling the real `AI`
 * binding — Workers AI has no local simulator, and this repository's spikes are explicitly
 * forbidden from using a remote binding in an automated test. A real deployed Worker's
 * `ENVIRONMENT` (from `wrangler.jsonc.tpl`'s `{{environment}}`, always something other than
 * `"test"`) always resolves to {@link WorkersAiArchitectureGenerator}, so this selection never
 * hides the real generator from production or from an authorized deployed smoke test.
 *
 * @param env The Workflow's own bindings.
 * @returns The generator implementation to use for this Workflow run.
 */
export function createArchitectureGenerator(
  env: Pick<Env, "AI" | "ENVIRONMENT">,
): ArchitectureGenerator {
  if (env.ENVIRONMENT === "test") {
    return new FixtureArchitectureGenerator();
  }
  return new WorkersAiArchitectureGenerator(env.AI);
}
