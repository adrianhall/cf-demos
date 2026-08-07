import { describe, expect, it } from "vitest";
import { validateArchitectureProposal } from "../../graph/proposal";
import { FixtureArchitectureGenerator, fixturePrompt } from "./fixtures";

describe("FixtureArchitectureGenerator", () => {
  const generator = new FixtureArchitectureGenerator();

  it("valid: returns raw text that passes proposal validation", async () => {
    const raw = await generator.generate({
      prompt: fixturePrompt("valid"),
      catalogSummary: "",
      attempt: 1,
    });
    const proposal = validateArchitectureProposal(JSON.parse(raw));
    expect(proposal.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it("malformed: returns text that is not valid JSON", async () => {
    const raw = await generator.generate({
      prompt: fixturePrompt("malformed"),
      catalogSummary: "",
      attempt: 1,
    });
    expect(() => JSON.parse(raw)).toThrow();
  });

  it("unknown-product: returns JSON referencing an uncurated product", async () => {
    const raw = await generator.generate({
      prompt: fixturePrompt("unknown-product"),
      catalogSummary: "",
      attempt: 1,
    });
    expect(() => validateArchitectureProposal(JSON.parse(raw))).toThrow();
  });

  it("invalid-edge: returns JSON with a dangling edge endpoint", async () => {
    const raw = await generator.generate({
      prompt: fixturePrompt("invalid-edge"),
      catalogSummary: "",
      attempt: 1,
    });
    // Shape-level validation passes (source/target are well-formed strings); the dangling
    // reference is caught later by the shared `validateGraphDocument`, matching production's
    // own two-stage validation.
    const proposal = validateArchitectureProposal(JSON.parse(raw));
    const nodeIds = new Set(proposal.nodes.map((node) => node.id));
    expect(proposal.edges.some((edge) => !nodeIds.has(edge.target))).toBe(true);
  });

  it("transient-then-success: throws on attempt 1, succeeds on attempt 2", async () => {
    await expect(
      generator.generate({
        prompt: fixturePrompt("transient-then-success"),
        catalogSummary: "",
        attempt: 1,
      }),
    ).rejects.toThrow(/transient/iu);

    const raw = await generator.generate({
      prompt: fixturePrompt("transient-then-success"),
      catalogSummary: "",
      attempt: 2,
    });
    expect(() => validateArchitectureProposal(JSON.parse(raw))).not.toThrow();
  });

  it("exhausted: throws on every attempt", async () => {
    await expect(
      generator.generate({
        prompt: fixturePrompt("exhausted"),
        catalogSummary: "",
        attempt: 1,
      }),
    ).rejects.toThrow(/permanent/iu);
    await expect(
      generator.generate({
        prompt: fixturePrompt("exhausted"),
        catalogSummary: "",
        attempt: 2,
      }),
    ).rejects.toThrow(/permanent/iu);
  });

  it("throws for an unrecognized fixture prompt", async () => {
    await expect(
      generator.generate({
        prompt: "__fixture__:nope",
        catalogSummary: "",
        attempt: 1,
      }),
    ).rejects.toThrow(/unrecognized/iu);
  });
});
