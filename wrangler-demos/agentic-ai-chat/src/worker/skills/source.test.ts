import { ProblemDetailsError } from "@adrianhall/cloudflare-toolkit/problem-details";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSkillSourceBody } from "./source";

/** Assert that `fn` rejects with a {@link ProblemDetailsError} with the given HTTP status. */
async function expectProblem(
  fn: () => Promise<unknown>,
  status: number,
): Promise<void> {
  try {
    await fn();
    expect.unreachable("expected fn to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemDetailsError);
    expect((error as ProblemDetailsError).problemDetails).toMatchObject({
      status,
    });
  }
}

describe("fetchSkillSourceBody", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and trims the response body for an allowed http(s) URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("  # Instructions  \n")),
    );

    const body = await fetchSkillSourceBody("https://example.com/skill.md");

    expect(body).toBe("# Instructions");
  });

  it("rejects a non-http(s) URL before ever calling fetch (the shared validateUrlFloor)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expectProblem(() => fetchSkillSourceBody("file:///etc/passwd"), 400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an obviously-internal hostname before ever calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expectProblem(
      () => fetchSkillSourceBody("http://169.254.169.254/latest/meta-data"),
      400,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when the fetch itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    await expectProblem(
      () => fetchSkillSourceBody("https://example.com/skill.md"),
      400,
    );
  });

  it("rejects a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
    );

    await expectProblem(
      () => fetchSkillSourceBody("https://example.com/missing.md"),
      422,
    );
  });

  it("rejects an empty response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("   ")));

    await expectProblem(
      () => fetchSkillSourceBody("https://example.com/empty.md"),
      422,
    );
  });
});
