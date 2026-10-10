import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createShare,
  getSharedDiagram,
  getShareStatus,
  revokeShare,
} from "./shares";

describe("shares API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getShareStatus", () => {
    it("requests the encoded diagram's share status", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            active: true,
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const status = await getShareStatus("a b");

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/diagrams/a%20b/share",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
      expect(status).toEqual({
        active: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
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

      await expect(getShareStatus("missing")).rejects.toThrow(
        "Diagram not found.",
      );
    });

    it("falls back to a generic message when the error response body is not JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("not json", { status: 500 })),
      );

      await expect(getShareStatus("d1")).rejects.toThrow(
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

      await expect(getShareStatus("d1")).rejects.toThrow("Not Found");
    });

    it("falls back to a generic message when the problem body has neither detail nor title", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({}), { status: 500 })),
      );

      await expect(getShareStatus("d1")).rejects.toThrow(
        "The request could not be completed.",
      );
    });
  });

  describe("createShare", () => {
    it("POSTs and returns the newly minted share", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            createdAt: "2026-01-01T00:00:00.000Z",
            token: "t".repeat(43),
            url: "https://architect.example/s/ttt",
          }),
          { status: 201 },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const share = await createShare("d1");

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/diagrams/d1/share",
        expect.objectContaining({ method: "POST" }),
      );
      expect(share.url).toBe("https://architect.example/s/ttt");
    });
  });

  describe("revokeShare", () => {
    it("DELETEs the diagram's share endpoint", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);

      await revokeShare("d1");

      expect(fetchMock).toHaveBeenCalledWith("/api/diagrams/d1/share", {
        method: "DELETE",
      });
    });

    it("throws the problem detail's message on failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              detail: "No active share link for this diagram.",
            }),
            { status: 404 },
          ),
        ),
      );

      await expect(revokeShare("d1")).rejects.toThrow(
        "No active share link for this diagram.",
      );
    });
  });

  describe("getSharedDiagram", () => {
    it("requests the encoded token and returns the shared diagram", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            diagram: {
              description: null,
              graphData: "{}",
              id: "d1",
              title: "Shared Diagram",
            },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const diagram = await getSharedDiagram("a b");

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/share/a%20b",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
      expect(diagram.title).toBe("Shared Diagram");
    });

    it("throws the problem detail's message when the token is unknown or revoked", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ detail: "Share link not found or revoked." }),
              { status: 404 },
            ),
          ),
      );

      await expect(getSharedDiagram("missing")).rejects.toThrow(
        "Share link not found or revoked.",
      );
    });
  });
});
