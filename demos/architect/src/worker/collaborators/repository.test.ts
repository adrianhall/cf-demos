import { describe, expect, it, vi } from "vitest";
import type { Diagram } from "../diagrams/types";
import { CollaboratorRepository } from "./repository";

/** In-memory shape of one `diagram_collaborators` row, matching the migration's columns. */
interface CollaboratorRow {
  diagram_id: string;
  collaborator_email: string;
  added_by: string;
  added_at: string;
}

/**
 * Minimal, *stateful* in-memory D1 double for the `diagram_collaborators` table, mirroring
 * `../shares/repository.test.ts`'s `FakeD1` shape: `add()` chains an `INSERT ... ON CONFLICT DO
 * NOTHING` and a `SELECT` within a single call, and the interaction between those two statements
 * (idempotency) is exactly what these tests verify.
 */
class FakeD1 {
  rows: CollaboratorRow[] = [];

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    const isInsert = normalized.startsWith("INSERT INTO diagram_collaborators");
    const isDelete = normalized.startsWith("DELETE FROM diagram_collaborators");
    const isExistsCheck = normalized.startsWith(
      "SELECT 1 FROM diagram_collaborators",
    );
    const isSelectOne = normalized.includes(
      "WHERE dc.diagram_id = ? AND dc.collaborator_email = ?",
    );
    const isSelectAll =
      normalized.includes("SELECT dc.diagram_id") &&
      normalized.includes("ORDER BY dc.added_at ASC");

    const rows = this.rows;
    let params: unknown[] = [];

    const statement = {
      bind: (...values: unknown[]) => {
        params = values;
        return statement;
      },
      first: async <T>() => {
        if (isExistsCheck) {
          const [diagramId, email] = params as [string, string];
          const found = rows.some(
            (row) =>
              row.diagram_id === diagramId && row.collaborator_email === email,
          );
          return (found ? { 1: 1 } : null) as T | null;
        }
        if (isSelectOne) {
          const [diagramId, email] = params as [string, string];
          const row = rows.find(
            (candidate) =>
              candidate.diagram_id === diagramId &&
              candidate.collaborator_email === email,
          );
          return (
            row === undefined
              ? null
              : {
                  added_at: row.added_at,
                  added_by: row.added_by,
                  collaborator_email: row.collaborator_email,
                  diagram_id: row.diagram_id,
                  display_name: null,
                }
          ) as T | null;
        }
        throw new Error(`FakeD1: unhandled first() for "${normalized}"`);
      },
      all: async <T>() => {
        if (isSelectAll) {
          const [diagramId] = params as [string];
          const results = rows
            .filter((row) => row.diagram_id === diagramId)
            .map((row) => ({
              added_at: row.added_at,
              added_by: row.added_by,
              collaborator_email: row.collaborator_email,
              diagram_id: row.diagram_id,
              display_name: null,
            }));
          return { results: results as T[] };
        }
        throw new Error(`FakeD1: unhandled all() for "${normalized}"`);
      },
      run: async () => {
        if (isInsert) {
          const [diagramId, email, addedBy, addedAt] = params as [
            string,
            string,
            string,
            string,
          ];
          const exists = rows.some(
            (row) =>
              row.diagram_id === diagramId && row.collaborator_email === email,
          );
          if (!exists) {
            rows.push({
              added_at: addedAt,
              added_by: addedBy,
              collaborator_email: email,
              diagram_id: diagramId,
            });
          }
          return { meta: { changes: exists ? 0 : 1 } };
        }
        if (isDelete) {
          const [diagramId, email] = params as [string, string];
          const index = rows.findIndex(
            (row) =>
              row.diagram_id === diagramId && row.collaborator_email === email,
          );
          if (index === -1) {
            return { meta: { changes: 0 } };
          }
          rows.splice(index, 1);
          return { meta: { changes: 1 } };
        }
        throw new Error(`FakeD1: unhandled run() for "${normalized}"`);
      },
    };
    return statement;
  }
}

/** Minimal diagram stub for `findOwned()`'s return value. */
function diagramFor(ownerEmail: string): Diagram {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    description: null,
    graphData: "{}",
    id: "d1",
    ownerEmail,
    title: "Untitled Diagram",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Build a fresh {@link CollaboratorRepository}, with controllable `findOwned`/`exists` fakes. */
function repositoryFor(
  options: { ownerEmail?: string; userExists?: boolean } = {},
) {
  const database = new FakeD1();
  const findOwned = vi.fn(async (_id: string, email: string) =>
    options.ownerEmail !== undefined && email === options.ownerEmail
      ? diagramFor(options.ownerEmail)
      : null,
  );
  const exists = vi.fn(async () => options.userExists ?? true);
  return {
    database,
    exists,
    findOwned,
    repository: new CollaboratorRepository(
      database as unknown as Pick<D1Database, "prepare">,
      { findOwned },
      { exists },
    ),
  };
}

describe("CollaboratorRepository", () => {
  describe("add", () => {
    it("adds a new collaborator to a diagram owned by the caller", async () => {
      const { database, repository } = repositoryFor({
        ownerEmail: "owner@example.com",
      });

      const collaborator = await repository.add(
        "d1",
        "owner@example.com",
        "colleague@example.com",
      );

      expect(collaborator).toMatchObject({
        addedBy: "owner@example.com",
        diagramId: "d1",
        displayName: null,
        email: "colleague@example.com",
      });
      expect(database.rows).toHaveLength(1);
    });

    it("throws not found when the diagram is not owned by the caller", async () => {
      const { repository } = repositoryFor({ ownerEmail: "owner@example.com" });

      await expect(
        repository.add("d1", "mallory@example.com", "colleague@example.com"),
      ).rejects.toMatchObject({ problemDetails: { status: 404 } });
    });

    it("throws bad request when adding the diagram's own owner", async () => {
      const { repository } = repositoryFor({ ownerEmail: "owner@example.com" });

      await expect(
        repository.add("d1", "owner@example.com", "owner@example.com"),
      ).rejects.toMatchObject({ problemDetails: { status: 400 } });
    });

    it("throws not found when the candidate email has never signed in", async () => {
      const { repository } = repositoryFor({
        ownerEmail: "owner@example.com",
        userExists: false,
      });

      await expect(
        repository.add("d1", "owner@example.com", "stranger@example.com"),
      ).rejects.toMatchObject({ problemDetails: { status: 404 } });
    });

    it("is idempotent: adding an already-added collaborator returns the existing row, not a duplicate", async () => {
      const { database, repository } = repositoryFor({
        ownerEmail: "owner@example.com",
      });

      const first = await repository.add(
        "d1",
        "owner@example.com",
        "colleague@example.com",
      );
      const second = await repository.add(
        "d1",
        "owner@example.com",
        "colleague@example.com",
      );

      expect(second).toEqual(first);
      expect(database.rows).toHaveLength(1);
    });
  });

  describe("remove", () => {
    it("allows the owner to remove any collaborator", async () => {
      const { database, repository } = repositoryFor({
        ownerEmail: "owner@example.com",
      });
      await repository.add("d1", "owner@example.com", "colleague@example.com");

      const removed = await repository.remove(
        "d1",
        "owner@example.com",
        "colleague@example.com",
      );

      expect(removed).toBe(true);
      expect(database.rows).toHaveLength(0);
    });

    it("allows a collaborator to remove themselves", async () => {
      const { repository } = repositoryFor({ ownerEmail: "owner@example.com" });
      await repository.add("d1", "owner@example.com", "colleague@example.com");

      const removed = await repository.remove(
        "d1",
        "colleague@example.com",
        "colleague@example.com",
      );

      expect(removed).toBe(true);
    });

    it("rejects a non-owner removing a different collaborator, before touching D1", async () => {
      const { database, repository } = repositoryFor({
        ownerEmail: "owner@example.com",
      });
      await repository.add("d1", "owner@example.com", "colleague@example.com");
      await repository.add("d1", "owner@example.com", "other@example.com");

      await expect(
        repository.remove("d1", "colleague@example.com", "other@example.com"),
      ).rejects.toMatchObject({ problemDetails: { status: 404 } });
      // Neither row was touched by the rejected call.
      expect(database.rows).toHaveLength(2);
    });

    it("returns false removing a collaborator row that does not exist", async () => {
      const { repository } = repositoryFor({ ownerEmail: "owner@example.com" });

      const removed = await repository.remove(
        "d1",
        "owner@example.com",
        "nobody@example.com",
      );

      expect(removed).toBe(false);
    });
  });

  describe("list", () => {
    it("lists every collaborator for a diagram, oldest added first", async () => {
      const { repository } = repositoryFor({ ownerEmail: "owner@example.com" });
      await repository.add("d1", "owner@example.com", "a@example.com");
      await repository.add("d1", "owner@example.com", "b@example.com");

      const collaborators = await repository.list("d1");

      expect(collaborators.map((c) => c.email)).toEqual([
        "a@example.com",
        "b@example.com",
      ]);
    });

    it("returns an empty array for a diagram with no collaborators", async () => {
      const { repository } = repositoryFor({ ownerEmail: "owner@example.com" });
      expect(await repository.list("d1")).toEqual([]);
    });
  });

  describe("isCollaborator", () => {
    it("returns true for an existing collaborator", async () => {
      const { repository } = repositoryFor({ ownerEmail: "owner@example.com" });
      await repository.add("d1", "owner@example.com", "colleague@example.com");

      expect(
        await repository.isCollaborator("d1", "colleague@example.com"),
      ).toBe(true);
    });

    it("returns false for a non-collaborator", async () => {
      const { repository } = repositoryFor({ ownerEmail: "owner@example.com" });
      expect(await repository.isCollaborator("d1", "nobody@example.com")).toBe(
        false,
      );
    });
  });
});
