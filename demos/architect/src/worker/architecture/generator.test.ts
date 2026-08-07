import { describe, expect, it, vi } from "vitest";
import { FixtureArchitectureGenerator } from "./fixtures";
import {
  ARCHITECTURE_MODEL,
  createArchitectureGenerator,
  WorkersAiArchitectureGenerator,
} from "./generator";

describe("WorkersAiArchitectureGenerator", () => {
  it("calls the verified model with a json_schema response_format and extracts response text", async () => {
    const run = vi.fn().mockResolvedValue({ response: '{"title":"x"}' });
    const generator = new WorkersAiArchitectureGenerator({ run });

    const text = await generator.generate({
      prompt: "Build an API",
      catalogSummary: "catalog summary",
      attempt: 1,
    });

    expect(text).toBe('{"title":"x"}');
    expect(run).toHaveBeenCalledWith(
      ARCHITECTURE_MODEL,
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: "system" }),
          { role: "user", content: "Build an API" },
        ],
        response_format: expect.objectContaining({ type: "json_schema" }),
        temperature: 0,
      }),
    );
  });

  it("accepts a bare string response", async () => {
    const run = vi.fn().mockResolvedValue('{"title":"x"}');
    const generator = new WorkersAiArchitectureGenerator({ run });
    const text = await generator.generate({
      prompt: "p",
      catalogSummary: "s",
      attempt: 1,
    });
    expect(text).toBe('{"title":"x"}');
  });

  it("re-serializes an already-parsed object response (observed from a deployed json_schema call)", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ response: { title: "x", nodes: [], edges: [] } });
    const generator = new WorkersAiArchitectureGenerator({ run });
    const text = await generator.generate({
      prompt: "p",
      catalogSummary: "s",
      attempt: 1,
    });
    expect(JSON.parse(text)).toEqual({ title: "x", nodes: [], edges: [] });
  });

  it("throws for an unsupported response shape", async () => {
    const run = vi.fn().mockResolvedValue({ requestId: "abc" });
    const generator = new WorkersAiArchitectureGenerator({ run });
    await expect(
      generator.generate({ prompt: "p", catalogSummary: "s", attempt: 1 }),
    ).rejects.toThrow(/unsupported response shape/u);
  });

  it("never leaks the prompt into the system instruction", async () => {
    const run = vi.fn().mockResolvedValue({ response: "{}" });
    const generator = new WorkersAiArchitectureGenerator({ run });
    await generator.generate({
      prompt: "SECRET_PROMPT_TEXT",
      catalogSummary: "catalog summary",
      attempt: 1,
    });
    const [, inputs] = run.mock.calls[0] as [
      string,
      { messages: Array<{ role: string; content: string }> },
    ];
    const systemMessage = inputs.messages.find((m) => m.role === "system");
    expect(systemMessage?.content).not.toContain("SECRET_PROMPT_TEXT");
  });
});

describe("createArchitectureGenerator", () => {
  it("selects the fixture generator in the test environment", () => {
    const generator = createArchitectureGenerator({
      AI: {} as Ai,
      ENVIRONMENT: "test",
    });
    expect(generator).toBeInstanceOf(FixtureArchitectureGenerator);
  });

  it("selects the real Workers AI generator outside the test environment", () => {
    const generator = createArchitectureGenerator({
      AI: {} as Ai,
      ENVIRONMENT: "production",
    });
    expect(generator).toBeInstanceOf(WorkersAiArchitectureGenerator);
  });
});
