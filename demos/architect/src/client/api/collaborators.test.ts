import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addCollaborator,
  listCollaborators,
  listSharedWithMe,
  removeCollaborator,
} from "./collaborators";

describe("collaborators API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("listCollaborators", () => {
    it("requests the encoded diagram's collaborator list", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            collaborators: [
              {
                addedAt: "2026-01-01T00:00:00.000Z",
                addedBy: "owner@example.com",
                diagramId: "a b",
                displayName: null,
                email: "colleague@example.com",
              },
            ],
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const collaborators = await listCollaborators("a b");

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/diagrams/a%20b/collaborators",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
      expect(collaborators).toHaveLength(1);
      expect(collaborators[0]?.email).toBe("colleague@example.com");
    });

    it("throws the problem detail's message on failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ detail: "Diagram not found." }), {
            status: 404,
          }),
        ),
      );

      await expect(listCollaborators("d1")).rejects.toThrow(
        "Diagram not found.",
      );
    });

    it("falls back to a generic message when the error response body is not JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("not json", { status: 500 })),
      );

      await expect(listCollaborators("d1")).rejects.toThrow(
        "The request could not be completed.",
      );
    });

    it("falls back to the problem's title when detail is absent", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ title: "Not Found" }), {
            status: 404,
          }),
        ),
      );

      await expect(listCollaborators("d1")).rejects.toThrow("Not Found");
    });

    it("falls back to a generic message when the problem body has neither detail nor title", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({}), { status: 500 })),
      );

      await expect(listCollaborators("d1")).rejects.toThrow(
        "The request could not be completed.",
      );
    });
  });

  describe("addCollaborator", () => {
    it("POSTs the email and returns the newly added collaborator", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            collaborator: {
              addedAt: "2026-01-01T00:00:00.000Z",
              addedBy: "owner@example.com",
              diagramId: "d1",
              displayName: null,
              email: "colleague@example.com",
            },
          }),
          { status: 201 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const collaborator = await addCollaborator("d1", "colleague@example.com");

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/diagrams/d1/collaborators",
        expect.objectContaining({
          body: JSON.stringify({ email: "colleague@example.com" }),
          method: "POST",
        }),
      );
      expect(collaborator.email).toBe("colleague@example.com");
    });

    it("throws the problem detail's message when the email has never signed in", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              detail:
                "That person needs to sign in to Architect at least once first.",
            }),
            { status: 404 },
          ),
        ),
      );

      await expect(
        addCollaborator("d1", "stranger@example.com"),
      ).rejects.toThrow(
        "That person needs to sign in to Architect at least once first.",
      );
    });

    it("throws the problem detail's message when adding the diagram's own owner", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              detail: "The diagram's owner cannot be added as a collaborator.",
            }),
            { status: 400 },
          ),
        ),
      );

      await expect(addCollaborator("d1", "owner@example.com")).rejects.toThrow(
        "The diagram's owner cannot be added as a collaborator.",
      );
    });
  });

  describe("removeCollaborator", () => {
    it("DELETEs the encoded diagram's collaborator endpoint", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);

      await removeCollaborator("d1", "a b@example.com");

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/diagrams/d1/collaborators/a%20b%40example.com",
        { method: "DELETE" },
      );
    });

    it("throws the problem detail's message on failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ detail: "Collaborator not found." }), {
            status: 404,
          }),
        ),
      );

      await expect(
        removeCollaborator("d1", "nobody@example.com"),
      ).rejects.toThrow("Collaborator not found.");
    });
  });

  describe("listSharedWithMe", () => {
    it("requests the shared-with-me endpoint and returns the diagram list", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            diagrams: [
              {
                createdAt: "2026-01-01T00:00:00.000Z",
                description: null,
                graphData: "{}",
                id: "d1",
                ownerEmail: "owner@example.com",
                title: "Shared Diagram",
                updatedAt: "2026-01-02T00:00:00.000Z",
              },
            ],
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const diagrams = await listSharedWithMe();

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/diagrams/shared-with-me",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
      expect(diagrams).toHaveLength(1);
      expect(diagrams[0]?.ownerEmail).toBe("owner@example.com");
    });

    it("throws the problem detail's message on failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ detail: "Something went wrong." }), {
            status: 500,
          }),
        ),
      );

      await expect(listSharedWithMe()).rejects.toThrow("Something went wrong.");
    });
  });
});
