import type { ArchitectureProposal, GeneratorFixture } from "./contracts";

/** Input supplied to the architecture-generation seam by the Workflow. */
export interface GenerateArchitectureInput {
  /** Fixture behavior used by this local-only proof. */
  fixture: GeneratorFixture;
  /** Current 1-indexed Workflow attempt. */
  attempt: number;
  /** Compact semantic summary produced by the preceding durable step. */
  summary: string;
}

/**
 * Boundary a future model adapter must implement.
 *
 * Implementations return raw text because model output is untrusted and is parsed and validated
 * by the Workflow's separate validation step.
 */
export interface ArchitectureGenerator {
  /** Generates raw structured output or throws an upstream failure. */
  generate(input: GenerateArchitectureInput): Promise<string>;
}

/** A deterministic, compiled generator that makes local retry and validation behavior testable. */
export class DeterministicArchitectureGenerator implements ArchitectureGenerator {
  /**
   * Generates one fixture response.
   *
   * @param input Fixture, durable-attempt number, and summary from the Workflow.
   * @returns Raw JSON for parsing or rejects to exercise a retryable upstream failure.
   */
  async generate(input: GenerateArchitectureInput): Promise<string> {
    void input.summary;
    if (input.fixture === "exhausted" || (input.fixture === "transient" && input.attempt === 1)) {
      throw new Error("deterministic upstream failure");
    }
    if (input.fixture === "malformed") return "{not-json";
    if (input.fixture === "unknown-product") return JSON.stringify({ nodes: [{ id: "n1", product: "unknown" }], edges: [] });
    if (input.fixture === "invalid-edge") return JSON.stringify({ nodes: [{ id: "n1", product: "workers" }], edges: [{ from: "n1", to: "missing" }] });
    return JSON.stringify(validProposal);
  }
}

/** Valid fixture shared by success and transient-retry probes. */
const validProposal: ArchitectureProposal = {
  nodes: [
    { id: "edge", product: "workers" },
    { id: "data", product: "d1" },
  ],
  edges: [{ from: "edge", to: "data" }],
};
