import { ProblemDetailsError } from "@adrianhall/cloudflare-toolkit/problem-details";
import { describe, expect, it } from "vitest";
import {
  validateCode,
  validateDestination,
  validateLinkInput,
} from "./validation";

/** Assert that `fn` throws a {@link ProblemDetailsError} shaped as `expected`. */
function expectProblem(
  fn: () => unknown,
  expected: { detail: string; status: number },
): void {
  try {
    fn();
    expect.unreachable("expected fn to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect((error as ProblemDetailsError).problemDetails).toMatchObject(
      expected,
    );
  }
}

describe("validateDestination", () => {
  it("accepts and canonicalizes an HTTPS destination", () => {
    expect(validateDestination("https://example.com/campaign")).toBe(
      "https://example.com/campaign",
    );
  });

  it("accepts an HTTP destination", () => {
    expect(validateDestination("http://example.com")).toBe(
      "http://example.com/",
    );
  });

  it("canonicalizes a URL missing its trailing slash", () => {
    expect(validateDestination("https://example.com")).toBe(
      "https://example.com/",
    );
  });

  it("rejects an empty destination", () => {
    expectProblem(() => validateDestination(""), {
      detail: "destination must be between 1 and 2048 characters.",
      status: 422,
    });
  });

  it("rejects a destination longer than 2048 characters", () => {
    const tooLong = `https://example.com/${"a".repeat(2048)}`;
    expectProblem(() => validateDestination(tooLong), {
      detail: "destination must be between 1 and 2048 characters.",
      status: 422,
    });
  });

  it("rejects a destination that is not an absolute URL", () => {
    expectProblem(() => validateDestination("not a url"), {
      detail: "destination must be an absolute URL.",
      status: 422,
    });
  });

  it("rejects a non-HTTP(S) scheme", () => {
    expectProblem(() => validateDestination("javascript:alert(1)"), {
      detail: "destination must use the HTTP or HTTPS scheme.",
      status: 422,
    });
  });

  it("rejects a data: URL", () => {
    expectProblem(() => validateDestination("data:text/html,unsafe"), {
      detail: "destination must use the HTTP or HTTPS scheme.",
      status: 422,
    });
  });
});

describe("validateLinkInput", () => {
  it("accepts a valid body and trims/canonicalizes the destination", () => {
    expect(
      validateLinkInput({ destination: "  https://example.com/campaign  " }),
    ).toEqual({
      destination: "https://example.com/campaign",
    });
  });

  it.each([null, 42, "a string", ["array"], true])(
    "rejects a non-object body: %j",
    (value) => {
      expectProblem(() => validateLinkInput(value), {
        detail: "The request body must be an object.",
        status: 400,
      });
    },
  );

  it("rejects a body missing destination", () => {
    expectProblem(() => validateLinkInput({}), {
      detail: "destination is required.",
      status: 422,
    });
  });

  it("rejects a body with a non-string destination", () => {
    expectProblem(() => validateLinkInput({ destination: 42 }), {
      detail: "destination is required.",
      status: 422,
    });
  });

  it("propagates destination validation errors", () => {
    expectProblem(
      () => validateLinkInput({ destination: "javascript:alert(1)" }),
      {
        detail: "destination must use the HTTP or HTTPS scheme.",
        status: 422,
      },
    );
  });
});

describe("validateCode", () => {
  it("accepts a well-shaped generated code", () => {
    expect(validateCode("AbCdEf123456")).toBe("AbCdEf123456");
  });

  it("accepts codes using the full URL-safe alphabet", () => {
    expect(validateCode("Ab-Cd_Ef1234")).toBe("Ab-Cd_Ef1234");
  });

  it.each([
    "../../etc/passwd",
    "too-short",
    "way-too-long-for-a-code",
    "",
    "with space12",
  ])("rejects an unsafe or malformed code: %j", (code) => {
    expectProblem(() => validateCode(code), {
      detail: "Short link not found.",
      status: 404,
    });
  });
});
