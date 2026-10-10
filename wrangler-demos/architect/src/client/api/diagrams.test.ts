import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiagram,
  type DiagramSummary,
  deleteDiagram,
  duplicateDiagram,
  getDiagram,
  listDiagrams,
  saveDiagramGraph,
  updateDiagram,
} from "./diagrams";

function diagram(overrides: Partial<DiagramSummary> = {}): DiagramSummary {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    description: null,
    graphData: "{}",
    id: "d1",
    ownerEmail: "alice@example.com",
    title: "My Diagram",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("diagrams API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("listDiagrams", () => {
    it("returns the diagrams array from a successful response", async () => {
      const diagrams = [diagram()];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ diagrams }))),
      );

      await expect(listDiagrams()).resolves.toEqual(diagrams);
    });

    it("throws the problem detail's message on failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ detail: "Unauthorized." }), {
            status: 401,
          }),
        ),
      );

      await expect(listDiagrams()).rejects.toThrow("Unauthorized.");
    });

    it("falls back to the title, then a generic message, when detail is absent", async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ title: "Not Found" }), {
              status: 404,
            }),
          )
          .mockResolvedValueOnce(new Response("not json", { status: 500 }))
          .mockResolvedValueOnce(
            new Response(JSON.stringify({}), { status: 500 }),
          ),
      );

      await expect(listDiagrams()).rejects.toThrow("Not Found");
      await expect(listDiagrams()).rejects.toThrow(
        "The request could not be completed.",
      );
      await expect(listDiagrams()).rejects.toThrow(
        "The request could not be completed.",
      );
    });
  });

  describe("getDiagram", () => {
    it("requests the encoded diagram path and returns the diagram", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ diagram: diagram({ id: "a b" }) })),
        );
      vi.stubGlobal("fetch", fetchMock);

      const result = await getDiagram("a b");

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/diagrams/a%20b",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        }),
      );
      expect(result.id).toBe("a b");
    });
  });

  describe("createDiagram", () => {
    it("POSTs the input and returns the created diagram", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ diagram: diagram() }), { status: 201 }),
        );
      vi.stubGlobal("fetch", fetchMock);

      await createDiagram({ blueprintId: "api-gateway", title: "New" });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/diagrams",
        expect.objectContaining({
          body: JSON.stringify({ blueprintId: "api-gateway", title: "New" }),
          method: "POST",
        }),
      );
    });
  });

  describe("updateDiagram", () => {
    it("PATCHes the encoded diagram path with the given fields", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ diagram: diagram() })),
        );
      vi.stubGlobal("fetch", fetchMock);

      await updateDiagram("d1", { description: null, title: "Renamed" });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/diagrams/d1",
        expect.objectContaining({
          body: JSON.stringify({ description: null, title: "Renamed" }),
          method: "PATCH",
        }),
      );
    });
  });

  describe("saveDiagramGraph", () => {
    it("PUTs the graph data and returns the new updatedAt", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ updatedAt: "2026-01-03T00:00:00.000Z" }),
          ),
        );
      vi.stubGlobal("fetch", fetchMock);

      await expect(saveDiagramGraph("d1", "{}")).resolves.toBe(
        "2026-01-03T00:00:00.000Z",
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/diagrams/d1/graph",
        expect.objectContaining({
          body: JSON.stringify({ graphData: "{}" }),
          method: "PUT",
        }),
      );
    });
  });

  describe("deleteDiagram", () => {
    it("DELETEs the encoded diagram path", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);

      await deleteDiagram("a b");

      expect(fetchMock).toHaveBeenCalledWith("/api/diagrams/a%20b", {
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

      await expect(deleteDiagram("missing")).rejects.toThrow(
        "Diagram not found.",
      );
    });
  });

  describe("duplicateDiagram", () => {
    it("creates a titled copy and saves the source graph into it", async () => {
      const source = diagram({
        graphData: '{"nodes":[{"id":"a"}]}',
        title: "Original",
      });
      const created = diagram({
        graphData: "{}",
        id: "d2",
        title: "Original (copy)",
      });

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ diagram: created }), { status: 201 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ updatedAt: "now" })),
        );
      vi.stubGlobal("fetch", fetchMock);

      const result = await duplicateDiagram(source);

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "/api/diagrams",
        expect.objectContaining({
          body: JSON.stringify({ title: "Original (copy)" }),
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/diagrams/d2/graph",
        expect.objectContaining({
          body: JSON.stringify({ graphData: source.graphData }),
        }),
      );
      expect(result).toEqual({ ...created, graphData: source.graphData });
    });
  });
});
