import { ProblemDetailsError } from "@adrianhall/cloudflare-toolkit/problem-details";
import { describe, expect, it } from "vitest";
import { readJsonBody } from "./read-json-body";

describe("readJsonBody", () => {
  it("parses a valid JSON body", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    await expect(readJsonBody(request)).resolves.toEqual({ a: 1 });
  });

  it("rejects a malformed JSON body with a 400 problem details error", async () => {
    const request = new Request("https://example.com", {
      method: "POST",
      body: "not json",
    });

    await expect(readJsonBody(request)).rejects.toBeInstanceOf(
      ProblemDetailsError,
    );
    try {
      await readJsonBody(
        new Request("https://example.com", { method: "POST", body: "{" }),
      );
      expect.unreachable("expected readJsonBody to throw");
    } catch (error) {
      expect((error as ProblemDetailsError).problemDetails).toMatchObject({
        status: 400,
        detail: "Request body must contain valid JSON.",
      });
    }
  });
});
