import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIdentity } from "./useIdentity";

describe("useIdentity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not update state after unmounting while a successful fetch is still in flight", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const { result, unmount } = renderHook(() => useIdentity());
    unmount();
    resolveFetch(
      new Response(
        JSON.stringify({ email: "alice@example.com", isAdmin: false }),
        { status: 200 },
      ),
    );
    await Promise.resolve();

    expect(result.current.loading).toBe(true);
  });

  it("does not update state after unmounting while a failing fetch is still in flight", async () => {
    let rejectFetch: (reason: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectFetch = reject;
          }),
      ),
    );

    const { result, unmount } = renderHook(() => useIdentity());
    unmount();
    rejectFetch(new Error("network down"));
    await Promise.resolve();

    expect(result.current.loading).toBe(true);
  });

  it("loads the verified identity and admin flag returned by the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ email: "admin@example.com", isAdmin: true }),
            { status: 200 },
          ),
        ),
    );

    const { result } = renderHook(() => useIdentity());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current).toMatchObject({
      email: "admin@example.com",
      error: null,
      isAdmin: true,
    });
  });

  it("exposes a problem-detail message after an API failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Access expired." }), {
          status: 401,
        }),
      ),
    );

    const { result } = renderHook(() => useIdentity());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current).toMatchObject({
      email: null,
      error: "Access expired.",
      isAdmin: false,
    });
  });

  it("falls back to the response status when an error body is not problem details", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("upstream error", { status: 502 })),
    );

    const { result } = renderHook(() => useIdentity());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Request failed with status 502.");
  });

  it("uses a safe message when fetch rejects a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));

    const { result } = renderHook(() => useIdentity());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe(
      "Could not verify your Cloudflare Access identity.",
    );
  });
});
