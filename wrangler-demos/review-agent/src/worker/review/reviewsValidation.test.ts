import { ProblemDetailsError } from "@adrianhall/cloudflare-toolkit/problem-details";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  validateListReviewRunsQuery,
  validateManualTriggerBody,
} from "./reviewsValidation";

/** Assert that `fn` throws a {@link ProblemDetailsError} with the given `status`. */
function expectProblem(fn: () => unknown, status: number): void {
  try {
    fn();
    expect.unreachable("expected fn to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect((error as ProblemDetailsError).problemDetails.status).toBe(status);
  }
}

describe("validateManualTriggerBody", () => {
  it("accepts a body with a non-empty url", () => {
    expect(
      validateManualTriggerBody({
        url: "https://github.com/octo-org/octo-repo/pull/42",
      }),
    ).toEqual({ url: "https://github.com/octo-org/octo-repo/pull/42" });
  });

  it("trims surrounding whitespace", () => {
    expect(
      validateManualTriggerBody({
        url: "  https://github.com/octo-org/octo-repo/pull/42  ",
      }),
    ).toEqual({ url: "https://github.com/octo-org/octo-repo/pull/42" });
  });

  it("rejects a missing url field", () => {
    expectProblem(() => validateManualTriggerBody({}), 400);
  });

  it("rejects an empty url", () => {
    expectProblem(() => validateManualTriggerBody({ url: "" }), 400);
  });

  it("rejects a url that is only whitespace", () => {
    expectProblem(() => validateManualTriggerBody({ url: "   " }), 400);
  });

  it("rejects a non-string url", () => {
    expectProblem(() => validateManualTriggerBody({ url: 42 }), 400);
  });

  it("rejects a null body", () => {
    expectProblem(() => validateManualTriggerBody(null), 400);
  });

  it("rejects an unparseable (undefined) body", () => {
    expectProblem(() => validateManualTriggerBody(undefined), 400);
  });
});

describe("validateListReviewRunsQuery", () => {
  it("defaults page and pageSize when both are omitted", () => {
    expect(validateListReviewRunsQuery({})).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
  });

  it("coerces valid numeric strings", () => {
    expect(validateListReviewRunsQuery({ page: "3", pageSize: "10" })).toEqual({
      page: 3,
      pageSize: 10,
    });
  });

  it("accepts pageSize exactly at the cap", () => {
    expect(
      validateListReviewRunsQuery({ pageSize: String(MAX_PAGE_SIZE) }),
    ).toEqual({ page: 1, pageSize: MAX_PAGE_SIZE });
  });

  it("rejects a pageSize above the cap", () => {
    expectProblem(
      () =>
        validateListReviewRunsQuery({ pageSize: String(MAX_PAGE_SIZE + 1) }),
      400,
    );
  });

  it("rejects page below 1", () => {
    expectProblem(() => validateListReviewRunsQuery({ page: "0" }), 400);
  });

  it("rejects pageSize below 1", () => {
    expectProblem(() => validateListReviewRunsQuery({ pageSize: "0" }), 400);
  });

  it("rejects a non-numeric page", () => {
    expectProblem(() => validateListReviewRunsQuery({ page: "abc" }), 400);
  });

  it("rejects a non-integer pageSize", () => {
    expectProblem(() => validateListReviewRunsQuery({ pageSize: "2.5" }), 400);
  });
});
