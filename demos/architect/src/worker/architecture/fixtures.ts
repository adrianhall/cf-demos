import type {
  ArchitectureGenerator,
  ArchitectureGeneratorRequest,
} from "./generator";

/**
 * Prefix marking a prompt as selecting a deterministic test fixture rather than free-form text.
 * Only ever recognized by {@link FixtureArchitectureGenerator}, which
 * `./generator.ts`'s `createArchitectureGenerator()` selects only when `env.ENVIRONMENT ===
 * "test"` — a real deployed Worker (`ENVIRONMENT` set from `wrangler.jsonc.tpl`'s
 * `{{environment}}`, always something other than `"test"`) always uses
 * `WorkersAiArchitectureGenerator` and never interprets this prefix specially.
 */
export const FIXTURE_PROMPT_PREFIX = "__fixture__:";

/** Every deterministic outcome the integration test suite can select via a fixture prompt. */
export type ArchitectureFixtureName =
  | "valid"
  | "malformed"
  | "unknown-product"
  | "invalid-edge"
  | "transient-then-success"
  | "exhausted";

/**
 * Build the fixture-selecting prompt `POST /api/diagrams/:id/proposals` (or a direct
 * `ArchitectureWorkflow.create()` call in a test) sends to deterministically exercise one
 * {@link FixtureArchitectureGenerator} outcome.
 *
 * @param name The fixture to select.
 * @returns A prompt string {@link FixtureArchitectureGenerator} recognizes.
 */
export function fixturePrompt(name: ArchitectureFixtureName): string {
  return `${FIXTURE_PROMPT_PREFIX}${name}`;
}

/** A minimal, always-valid raw model output used by the `"valid"` and `"transient-then-success"` fixtures. */
const VALID_RAW_PROPOSAL = JSON.stringify({
  title: "Simple API",
  nodes: [
    { id: "client", type: "actor", label: "Client application" },
    {
      id: "api",
      type: "product",
      productId: "workers",
      label: "API Worker",
      description: "Handles requests",
    },
  ],
  edges: [
    {
      id: "request",
      source: "client",
      target: "api",
      type: "request",
      label: "HTTPS request",
    },
  ],
});

/** Raw output referencing a catalog product id that does not exist, for the `"unknown-product"` fixture. */
const UNKNOWN_PRODUCT_RAW_PROPOSAL = JSON.stringify({
  title: "Invalid product",
  nodes: [
    { id: "client", type: "actor", label: "Client application" },
    {
      id: "mystery",
      type: "product",
      productId: "not-a-real-product",
      label: "Mystery service",
    },
  ],
  edges: [],
});

/** Raw output with an edge pointing at a node id that does not exist, for the `"invalid-edge"` fixture. */
const INVALID_EDGE_RAW_PROPOSAL = JSON.stringify({
  title: "Dangling edge",
  nodes: [
    { id: "client", type: "actor", label: "Client application" },
    {
      id: "api",
      type: "product",
      productId: "workers",
      label: "API Worker",
    },
  ],
  edges: [
    {
      id: "request",
      source: "client",
      target: "does-not-exist",
      type: "request",
      label: "HTTPS request",
    },
  ],
});

/**
 * Parse a fixture-selecting prompt back into its {@link ArchitectureFixtureName}.
 *
 * @param prompt The prompt text.
 * @returns The selected fixture name.
 * @throws {Error} When `prompt` does not select a recognized fixture — a test bug, never a real
 * production code path.
 */
function parseFixtureName(prompt: string): ArchitectureFixtureName {
  const name = prompt.slice(FIXTURE_PROMPT_PREFIX.length);
  if (
    name === "valid" ||
    name === "malformed" ||
    name === "unknown-product" ||
    name === "invalid-edge" ||
    name === "transient-then-success" ||
    name === "exhausted"
  ) {
    return name;
  }
  throw new Error(`Unrecognized architecture fixture prompt: ${prompt}`);
}

/**
 * Deterministic {@link ArchitectureGenerator} test double, selected only in the integration test
 * environment (`./generator.ts`'s `createArchitectureGenerator()`) so no automated test ever
 * calls the real `AI` binding, per `docs/09-ARCHITECT.md`'s Phase 5 testing guidance and Spike
 * 08's own restriction. Mirrors Spike 08's `DeterministicArchitectureGenerator` fixture seam,
 * adapted to select its fixture from the request's `prompt` field instead of a separate
 * test-only payload field, so the real `ArchitectureWorkflowInput` stays exactly the fields
 * production actually needs.
 */
export class FixtureArchitectureGenerator implements ArchitectureGenerator {
  async generate(request: ArchitectureGeneratorRequest): Promise<string> {
    const fixture = parseFixtureName(request.prompt);
    switch (fixture) {
      case "valid":
        return VALID_RAW_PROPOSAL;
      case "malformed":
        return "this is not valid JSON {{{";
      case "unknown-product":
        return UNKNOWN_PRODUCT_RAW_PROPOSAL;
      case "invalid-edge":
        return INVALID_EDGE_RAW_PROPOSAL;
      case "transient-then-success":
        // step.do provides a 1-indexed attempt; only the first attempt fails.
        if (request.attempt === 1) {
          throw new Error("Simulated transient generator failure.");
        }
        return VALID_RAW_PROPOSAL;
      case "exhausted":
        throw new Error("Simulated permanent generator failure.");
      default: {
        const exhaustive: never = fixture;
        throw new Error(
          `Unhandled architecture fixture: ${String(exhaustive)}`,
        );
      }
    }
  }
}
