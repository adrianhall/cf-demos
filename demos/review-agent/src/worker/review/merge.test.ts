import { describe, expect, it } from "vitest";
import { mergeFindings } from "./merge";
import type { RawFinding } from "./schema";

function finding(overrides: Partial<RawFinding>): RawFinding {
  return {
    findingRef: "REF-001",
    severity: "medium",
    category: "Test",
    filePath: "src/index.ts",
    lineNumber: 10,
    finding: "A finding",
    recommendation: "Fix it",
    ...overrides,
  };
}

describe("mergeFindings", () => {
  it("leaves a single-contributor finding unmerged", () => {
    const result = mergeFindings({
      "code-quality": [finding({ findingRef: "CODE-001", severity: "low" })],
    });

    expect(result).toEqual([
      expect.objectContaining({
        findingRef: "CODE-001",
        priority: "P3",
        mergedFrom: null,
        role: "code-quality",
      }),
    ]);
  });

  it("merges two findings from different reviewers sharing the same (filePath, lineNumber)", () => {
    const result = mergeFindings({
      architecture: [
        finding({
          findingRef: "ARCH-001",
          severity: "high",
          filePath: "a.ts",
          lineNumber: 5,
        }),
      ],
      "code-quality": [
        finding({
          findingRef: "CODE-003",
          severity: "medium",
          filePath: "a.ts",
          lineNumber: 5,
        }),
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      findingRef: "ARCH-001+",
      priority: "P1",
      mergedFrom: "architecture,code-quality",
      role: "architecture",
    });
  });

  it("merges three findings across three reviewers at the same location", () => {
    const result = mergeFindings({
      architecture: [
        finding({
          findingRef: "ARCH-001",
          severity: "medium",
          filePath: "a.ts",
          lineNumber: 5,
        }),
      ],
      security: [
        finding({
          findingRef: "SEC-001",
          severity: "critical",
          filePath: "a.ts",
          lineNumber: 5,
        }),
      ],
      "code-quality": [
        finding({
          findingRef: "CODE-001",
          severity: "low",
          filePath: "a.ts",
          lineNumber: 5,
        }),
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      findingRef: "SEC-001+",
      priority: "P0",
      mergedFrom: "architecture,security,code-quality",
    });
  });

  it("never merges findings with a null filePath or lineNumber, even if otherwise identical", () => {
    const result = mergeFindings({
      architecture: [
        finding({ findingRef: "ARCH-001", filePath: null, lineNumber: null }),
      ],
      security: [
        finding({ findingRef: "SEC-001", filePath: null, lineNumber: null }),
      ],
    });

    expect(result).toHaveLength(2);
    expect(result.every((row) => row.mergedFrom === null)).toBe(true);
  });

  it("never demotes a critical finding's P0 priority, regardless of what it merges with (no override)", () => {
    const result = mergeFindings({
      architecture: [
        finding({
          findingRef: "ARCH-001",
          severity: "critical",
          filePath: "a.ts",
          lineNumber: 1,
        }),
      ],
      "code-quality": [
        finding({
          findingRef: "CODE-001",
          severity: "low",
          filePath: "a.ts",
          lineNumber: 1,
        }),
      ],
    });

    expect(result[0]?.priority).toBe("P0");
    expect(result[0]?.severity).toBe("critical");
  });

  it("keeps an unmerged critical finding at P0 (no override applies unconditionally)", () => {
    const result = mergeFindings({
      security: [finding({ severity: "critical" })],
    });

    expect(result[0]?.priority).toBe("P0");
  });

  it("sorts by priority ascending, then role order, then filePath", () => {
    const result = mergeFindings({
      accessibility: [
        finding({
          findingRef: "A11Y-001",
          severity: "low",
          filePath: "z.ts",
          lineNumber: 1,
        }),
      ],
      "code-quality": [
        finding({
          findingRef: "CODE-001",
          severity: "low",
          filePath: "b.ts",
          lineNumber: 1,
        }),
      ],
      security: [
        finding({
          findingRef: "SEC-001",
          severity: "critical",
          filePath: "y.ts",
          lineNumber: 1,
        }),
      ],
      architecture: [
        finding({
          findingRef: "ARCH-001",
          severity: "high",
          filePath: "a.ts",
          lineNumber: 1,
        }),
      ],
    });

    expect(result.map((row) => row.findingRef)).toEqual([
      "SEC-001",
      "ARCH-001",
      "CODE-001",
      "A11Y-001",
    ]);
  });

  it("sorts by filePath within the same priority and role tier", () => {
    const result = mergeFindings({
      architecture: [
        finding({
          findingRef: "ARCH-002",
          severity: "high",
          filePath: "b.ts",
          lineNumber: 1,
        }),
        finding({
          findingRef: "ARCH-001",
          severity: "high",
          filePath: "a.ts",
          lineNumber: 1,
        }),
      ],
    });

    expect(result.map((row) => row.findingRef)).toEqual([
      "ARCH-001",
      "ARCH-002",
    ]);
  });

  it("sorts a null filePath after every non-null filePath at the same priority/role", () => {
    const result = mergeFindings({
      architecture: [
        finding({
          findingRef: "ARCH-002",
          severity: "high",
          filePath: null,
          lineNumber: null,
        }),
        finding({
          findingRef: "ARCH-001",
          severity: "high",
          filePath: "a.ts",
          lineNumber: 1,
        }),
      ],
    });

    expect(result.map((row) => row.findingRef)).toEqual([
      "ARCH-001",
      "ARCH-002",
    ]);
  });

  it("treats a missing role key the same as an empty findings list", () => {
    const result = mergeFindings({ architecture: [finding({})] });

    expect(result).toHaveLength(1);
  });

  it("keeps stable relative order for two findings sharing the exact same filePath", () => {
    // Two distinct ungrouped findings (different lineNumber, so they never merge) that happen
    // to share a filePath -- the `a.filePath === b.filePath` sort branch.
    const result = mergeFindings({
      architecture: [
        finding({
          findingRef: "ARCH-001",
          severity: "high",
          filePath: "a.ts",
          lineNumber: 1,
        }),
        finding({
          findingRef: "ARCH-002",
          severity: "high",
          filePath: "a.ts",
          lineNumber: 2,
        }),
      ],
    });

    expect(result.map((row) => row.findingRef)).toEqual([
      "ARCH-001",
      "ARCH-002",
    ]);
  });

  it("sorts a non-null filePath before a null filePath (the b.filePath === null branch)", () => {
    const result = mergeFindings({
      architecture: [
        finding({
          findingRef: "ARCH-001",
          severity: "high",
          filePath: "a.ts",
          lineNumber: 1,
        }),
        finding({
          findingRef: "ARCH-002",
          severity: "high",
          filePath: null,
          lineNumber: null,
        }),
      ],
    });

    expect(result.map((row) => row.findingRef)).toEqual([
      "ARCH-001",
      "ARCH-002",
    ]);
  });
});
