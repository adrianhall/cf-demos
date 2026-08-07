import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useInvitationRedemptionStore } from "./invitation-redemption";

afterEach(() => vi.unstubAllGlobals());

describe("useInvitationRedemptionStore", () => {
  it("redeems a token and records the diagram id", async () => {
    setActivePinia(createPinia());
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ diagramId: "diagram-1" })),
      );
    vi.stubGlobal("fetch", fetchMock);

    const store = useInvitationRedemptionStore();
    const diagramId = await store.redeem("raw-token-value");

    expect(diagramId).toBe("diagram-1");
    expect(store.diagramId).toBe("diagram-1");
    expect(store.error).toBe("");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/invitations/redeem",
      expect.objectContaining({
        body: JSON.stringify({ token: "raw-token-value" }),
        method: "POST",
      }),
    );
  });

  it("records a user-safe error for an expired or revoked token", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ detail: "This invitation is no longer valid." }),
          {
            status: 410,
          },
        ),
      ),
    );

    const store = useInvitationRedemptionStore();
    const diagramId = await store.redeem("raw-token-value");

    expect(diagramId).toBeUndefined();
    expect(store.error).toBe("This invitation is no longer valid.");
  });

  it("records a network-failure error when fetch throws", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const store = useInvitationRedemptionStore();
    const diagramId = await store.redeem("raw-token-value");

    expect(diagramId).toBeUndefined();
    expect(store.error).toContain("Could not reach the server");
  });
});
