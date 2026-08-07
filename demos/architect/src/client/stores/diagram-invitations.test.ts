import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDiagramInvitationsStore } from "./diagram-invitations";

afterEach(() => vi.unstubAllGlobals());

describe("useDiagramInvitationsStore", () => {
  it("creates an invitation, keeps the raw token once, and lists it as active", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            invitation: {
              id: "invite-1",
              diagramId: "diagram-1",
              creatorEmail: "owner@example.com",
              expiresAt: "2026-01-03T00:00:00.000Z",
            },
            token: "raw-token-value",
          }),
          { status: 201 },
        ),
      ),
    );
    const store = useDiagramInvitationsStore();
    await store.create("diagram-1");

    expect(store.invitations).toHaveLength(1);
    expect(store.invitations[0].id).toBe("invite-1");
    expect(store.lastCreatedToken).toBe("raw-token-value");
    expect(store.error).toBe("");
  });

  it("clears the one-time raw token from memory on request", async () => {
    setActivePinia(createPinia());
    const store = useDiagramInvitationsStore();
    store.lastCreatedToken = "raw-token-value";
    store.clearLastCreatedToken();
    expect(store.lastCreatedToken).toBe("");
  });

  it("records a user-safe error when creation fails", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ detail: "Only the diagram's owner can do this." }),
          {
            status: 403,
          },
        ),
      ),
    );
    const store = useDiagramInvitationsStore();
    await store.create("diagram-1");
    expect(store.error).toBe("Only the diagram's owner can do this.");
    expect(store.invitations).toEqual([]);
  });

  it("loads active invitations", async () => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            invitations: [
              {
                id: "invite-1",
                diagramId: "diagram-1",
                creatorEmail: "owner@example.com",
                expiresAt: "2026-01-03T00:00:00.000Z",
              },
            ],
          }),
        ),
      ),
    );
    const store = useDiagramInvitationsStore();
    await store.load("diagram-1");
    expect(store.invitations).toHaveLength(1);
  });

  it("revokes an invitation and removes it from the active list", async () => {
    setActivePinia(createPinia());
    const store = useDiagramInvitationsStore();
    store.invitations = [
      {
        id: "invite-1",
        diagramId: "diagram-1",
        creatorEmail: "owner@example.com",
        expiresAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );

    await store.revoke("diagram-1", "invite-1");

    expect(store.invitations).toEqual([]);
  });

  it("records a user-safe error when revoke fails", async () => {
    setActivePinia(createPinia());
    const store = useDiagramInvitationsStore();
    store.invitations = [
      {
        id: "invite-1",
        diagramId: "diagram-1",
        creatorEmail: "owner@example.com",
        expiresAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ detail: "Only the diagram's owner can do this." }),
          {
            status: 403,
          },
        ),
      ),
    );

    await store.revoke("diagram-1", "invite-1");

    expect(store.error).toBe("Only the diagram's owner can do this.");
    // The list is unchanged on failure — nothing is optimistically removed.
    expect(store.invitations).toHaveLength(1);
  });
});
