import { describe, expect, it } from "vitest";
import { parseFencedFindings } from "./schema";

const VALID_FINDING = {
  findingRef: "ARCH-001",
  severity: "high",
  category: "Repository pattern",
  filePath: "src/worker/routes/orders.ts",
  lineNumber: 42,
  finding: "SQL built inline in the HTTP handler",
  recommendation: "Extract to an OrdersRepository",
};

describe("parseFencedFindings", () => {
  it("parses a valid fenced json block with prose before it", () => {
    const output = `Here is my review.\n\n\`\`\`json\n${JSON.stringify([VALID_FINDING])}\n\`\`\``;

    expect(parseFencedFindings(output)).toEqual([VALID_FINDING]);
  });

  it("parses an empty findings array", () => {
    const output = "Looks good, no findings.\n```json\n[]\n```";

    expect(parseFencedFindings(output)).toEqual([]);
  });

  it("takes the LAST fenced block when more than one is present", () => {
    const output = [
      "Example shape:",
      "```json",
      '[{"not": "real"}]',
      "```",
      "Actual findings:",
      "```json",
      JSON.stringify([VALID_FINDING]),
      "```",
    ].join("\n");

    expect(parseFencedFindings(output)).toEqual([VALID_FINDING]);
  });

  it("tolerates a fenced block with no json language tag", () => {
    const output = `\`\`\`\n${JSON.stringify([VALID_FINDING])}\n\`\`\``;

    expect(parseFencedFindings(output)).toEqual([VALID_FINDING]);
  });

  it("throws a descriptive error when no fenced block is present", () => {
    expect(() => parseFencedFindings("just some prose, no code block")).toThrow(
      /No fenced code block/,
    );
  });

  it("throws a descriptive error when the fenced block is not valid JSON", () => {
    const output = "```json\nnot json at all {{{\n```";

    expect(() => parseFencedFindings(output)).toThrow(/not valid JSON/);
  });

  it("throws a descriptive error when the parsed JSON does not match the schema", () => {
    const output = `\`\`\`json\n${JSON.stringify([{ findingRef: "X" }])}\n\`\`\``;

    expect(() => parseFencedFindings(output)).toThrow(
      /does not match the expected findings array shape/,
    );
  });

  it("throws when the fenced block is a JSON object instead of an array", () => {
    const output = `\`\`\`json\n${JSON.stringify(VALID_FINDING)}\n\`\`\``;

    expect(() => parseFencedFindings(output)).toThrow();
  });
});
