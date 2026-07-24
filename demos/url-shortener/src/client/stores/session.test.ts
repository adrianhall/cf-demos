import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "./session";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setActivePinia(createPinia());
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session store", () => {
  it("authorizes and records the email for a successful /api/me response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ email: "admin@example.com" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    );
    const store = useSessionStore();

    await store.check();

    expect(fetchMock).toHaveBeenCalledWith("/api/me");
    expect(store.authorized).toBe(true);
    expect(store.email).toBe("admin@example.com");
    expect(store.checking).toBe(false);
  });

  it.each([401, 403])(
    "marks the identity unauthorized on a %s response",
    async (status) => {
      fetchMock.mockResolvedValue(new Response(null, { status }));
      const store = useSessionStore();

      await store.check();

      expect(store.authorized).toBe(false);
      expect(store.email).toBe("");
      expect(store.checking).toBe(false);
    },
  );

  it("marks the identity unauthorized when the request itself fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const store = useSessionStore();

    await store.check();

    expect(store.authorized).toBe(false);
    expect(store.checking).toBe(false);
  });

  it("sets checking while the request is pending", () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const store = useSessionStore();

    const pending = store.check();
    expect(store.checking).toBe(true);

    resolveFetch(new Response(null, { status: 401 }));
    return pending;
  });
});
