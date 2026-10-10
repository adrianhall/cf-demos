import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteAnyDiagram, getAnyDiagram, listUsers } from "./admin";

describe("admin API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("listUsers", () => {
    it("requests the directory with no query string when no options are given", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ limit: 20, offset: 0, total: 0, users: [] }),
          ),
        );
      vi.stubGlobal("fetch", fetchMock);

      await listUsers();

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/users",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
    });

    it("encodes limit and offset into the query string", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ limit: 5, offset: 10, total: 0, users: [] }),
          ),
        );
      vi.stubGlobal("fetch", fetchMock);

      await listUsers({ limit: 5, offset: 10 });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/users?limit=5&offset=10",
        expect.anything(),
      );
    });

    it("returns the decoded page", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              limit: 20,
              offset: 0,
              total: 1,
              users: [
                {
                  diagramCount: 2,
                  displayName: null,
                  email: "alice@example.com",
                  firstSeenAt: "2026-01-01T00:00:00.000Z",
                  lastSeenAt: "2026-01-02T00:00:00.000Z",
                },
              ],
            }),
          ),
        ),
      );

      const page = await listUsers();

      expect(page.total).toBe(1);
      expect(page.users[0]).toMatchObject({
        diagramCount: 2,
        email: "alice@example.com",
      });
    });

    it("throws the problem detail's message when the caller is not the administrator", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              detail:
                "This Cloudflare Access identity is not the configured administrator.",
            }),
            { status: 403 },
          ),
        ),
      );

      await expect(listUsers()).rejects.toThrow(
        "This Cloudflare Access identity is not the configured administrator.",
      );
    });

    it("falls back to a generic message when the error response body is not JSON", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("not json", { status: 500 })),
      );

      await expect(listUsers()).rejects.toThrow(
        "The request could not be completed.",
      );
    });

    it("falls back to a generic message when the problem body has neither detail nor title", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("{}", { status: 500 })),
      );

      await expect(listUsers()).rejects.toThrow(
        "The request could not be completed.",
      );
    });
  });

  describe("getAnyDiagram", () => {
    it("requests the encoded diagram id and returns its public fields", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            diagram: {
              description: null,
              graphData: "{}",
              id: "a b",
              title: "Reviewed Diagram",
            },
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const diagram = await getAnyDiagram("a b");

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/diagrams/a%20b",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
      expect(diagram.title).toBe("Reviewed Diagram");
    });

    it("throws the problem detail's message when the diagram does not exist", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ detail: "Diagram not found." }), {
            status: 404,
          }),
        ),
      );

      await expect(getAnyDiagram("missing")).rejects.toThrow(
        "Diagram not found.",
      );
    });
  });

  describe("deleteAnyDiagram", () => {
    it("DELETEs the admin moderation endpoint for the encoded diagram id", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);

      await deleteAnyDiagram("a b");

      expect(fetchMock).toHaveBeenCalledWith("/api/admin/diagrams/a%20b", {
        method: "DELETE",
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

      await expect(deleteAnyDiagram("missing")).rejects.toThrow(
        "Diagram not found.",
      );
    });
  });
});
