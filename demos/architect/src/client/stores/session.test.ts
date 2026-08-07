import { setActivePinia, createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "./session";

afterEach(() => vi.unstubAllGlobals());

describe("useSessionStore", () => {
  it("records the verified identity", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ email: "architect@example.com" })),
        ),
    );
    const session = useSessionStore();
    await session.load();
    expect(session.email).toBe("architect@example.com");
    expect(session.error).toBe("");
  });

  it("shows a safe message when identity confirmation fails", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );
    const session = useSessionStore();
    await session.load();
    expect(session.error).toBe(
      "Unable to confirm your Cloudflare Access identity.",
    );
  });
});
