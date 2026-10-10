import { ProblemDetailsError } from "@adrianhall/cloudflare-toolkit/problem-details";
import { describe, expect, it } from "vitest";
import {
  buildSkillMarkdown,
  MAX_SKILL_CONTENT_BYTES,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  sanitizeSkillDescription,
  sanitizeSkillName,
  validateSkillBody,
} from "./validation";

/** Assert that `fn` throws a {@link ProblemDetailsError} with the given HTTP status -- mirrors
 * `../transcribe/validation.test.ts`'s own `expectProblem()` convention. */
function expectProblem(fn: () => unknown, status: number): void {
  try {
    fn();
    expect.unreachable("expected fn to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect((error as ProblemDetailsError).problemDetails).toMatchObject({
      status,
    });
  }
}

describe("sanitizeSkillName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(sanitizeSkillName("  brand   voice  ")).toBe("brand voice");
  });

  it("throws 400 for a non-string value", () => {
    expectProblem(() => sanitizeSkillName(42), 400);
  });

  it("throws 422 for a name that is only whitespace", () => {
    expectProblem(() => sanitizeSkillName("   "), 422);
  });

  it("throws 422 for a name over the length cap", () => {
    expectProblem(
      () => sanitizeSkillName("a".repeat(MAX_SKILL_NAME_LENGTH + 1)),
      422,
    );
  });

  it("accepts a name exactly at the length cap", () => {
    const name = "a".repeat(MAX_SKILL_NAME_LENGTH);
    expect(sanitizeSkillName(name)).toBe(name);
  });
});

describe("sanitizeSkillDescription", () => {
  it("trims and collapses internal whitespace", () => {
    expect(sanitizeSkillDescription("  Use this   for trips  ")).toBe(
      "Use this for trips",
    );
  });

  it("throws 400 for a non-string value", () => {
    expectProblem(() => sanitizeSkillDescription(null), 400);
  });

  it("throws 422 for an empty description", () => {
    expectProblem(() => sanitizeSkillDescription(""), 422);
  });

  it("throws 422 for a description over the length cap", () => {
    expectProblem(
      () =>
        sanitizeSkillDescription("a".repeat(MAX_SKILL_DESCRIPTION_LENGTH + 1)),
      422,
    );
  });
});

describe("validateSkillBody", () => {
  it("trims surrounding whitespace", () => {
    expect(validateSkillBody("  # Instructions  \n")).toBe("# Instructions");
  });

  it("throws 400 for a non-string value", () => {
    expectProblem(() => validateSkillBody(undefined), 400);
  });

  it("throws 422 for an empty body", () => {
    expectProblem(() => validateSkillBody("   "), 422);
  });

  it("throws 413 for a body over the byte cap", () => {
    expectProblem(
      () => validateSkillBody("a".repeat(MAX_SKILL_CONTENT_BYTES + 1)),
      413,
    );
  });
});

describe("buildSkillMarkdown", () => {
  it("builds a YAML-frontmatter document with the given name/description/body", () => {
    const markdown = buildSkillMarkdown(
      "cloudflare-spike-fact",
      "Use whenever the user asks for the spike passphrase.",
      "Fetch references/passphrase.md and report it verbatim.",
    );

    expect(markdown).toBe(
      '---\nname: "cloudflare-spike-fact"\n' +
        'description: "Use whenever the user asks for the spike passphrase."\n' +
        "---\n\nFetch references/passphrase.md and report it verbatim.\n",
    );
  });

  it("escapes an embedded double quote and backslash in name/description", () => {
    const markdown = buildSkillMarkdown(
      'the "brand" voice',
      "back\\slash",
      "body",
    );

    expect(markdown).toContain('name: "the \\"brand\\" voice"');
    expect(markdown).toContain('description: "back\\\\slash"');
  });

  it("escapes an embedded newline so the frontmatter block stays exactly two lines", () => {
    const markdown = buildSkillMarkdown("multi\nline", "description", "body");

    expect(markdown.split("\n").slice(0, 4)).toEqual([
      "---",
      'name: "multi\\nline"',
      'description: "description"',
      "---",
    ]);
  });
});
