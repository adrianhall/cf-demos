import { ProblemDetailsError } from "@adrianhall/cloudflare-toolkit/problem-details";
import { describe, expect, it } from "vitest";
import { readJsonBody } from "./read-json-body";

/** Build a `POST` request with the given raw body text. */
function postRequest(body: string): Request {
  return new Request("https://example.com/api/links", { body, method: "POST" });
}

describe("readJsonBody", () => {
  it("parses a well-formed JSON object body", async () => {
    await expect(
      readJsonBody(
        postRequest(JSON.stringify({ destination: "https://example.com" })),
      ),
    ).resolves.toEqual({ destination: "https://example.com" });
  });

  it("parses any valid JSON value, not only objects", async () => {
    // readJsonBody only parses JSON; shape validation is validateLinkInput's job.
    await expect(readJsonBody(postRequest("42"))).resolves.toBe(42);
    await expect(readJsonBody(postRequest("null"))).resolves.toBeNull();
  });

  it("rejects malformed JSON with a 400 problem detail", async () => {
    try {
      await readJsonBody(postRequest("{not-json"));
      expect.unreachable("readJsonBody should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemDetailsError);
      expect((error as ProblemDetailsError).problemDetails).toMatchObject({
        detail: "Request body must contain valid JSON.",
        status: 400,
      });
    }
  });

  it("rejects an empty body with a 400 problem detail", async () => {
    await expect(readJsonBody(postRequest(""))).rejects.toBeInstanceOf(
      ProblemDetailsError,
    );
  });
});
