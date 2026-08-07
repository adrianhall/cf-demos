import { describe, expect, it } from "vitest";
import { ArchitectureJobRepository } from "./repository";

/** A recorded D1 statement used to verify the repository's queries and bound parameters. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/** Build a minimal D1 double that returns `row` from every `first()` call and records every statement. */
function databaseFor(row: Record<string, unknown> | null): {
  database: Pick<D1Database, "prepare">;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];
  let latestStatement: RecordedStatement | undefined;
  function buildStatement() {
    return {
      all: async <T>() => ({
        meta: {
          changed_db: false,
          changes: 0,
          duration: 0,
          last_row_id: 0,
          rows_read: 0,
          rows_written: 0,
          size_after: 0,
        },
        results: (row ? [row] : []) as T[],
        success: true as const,
      }),
      bind(...parameters: unknown[]) {
        if (latestStatement !== undefined) {
          latestStatement.parameters = parameters;
        }
        return this;
      },
      first: async <T>() => row as T | null,
      raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
      run: async <T>() => ({
        meta: {
          changed_db: false,
          changes: 1,
          duration: 0,
          last_row_id: 0,
          rows_read: 0,
          rows_written: 0,
          size_after: 0,
        },
        results: [] as T[],
        success: true as const,
      }),
    };
  }
  const database = {
    prepare(sql: string) {
      latestStatement = { parameters: [], sql };
      statements.push(latestStatement);
      return buildStatement();
    },
  } satisfies Pick<D1Database, "prepare">;
  return { database, statements };
}

const row = {
  id: "job-1",
  workflow_instance_id: "job-1",
  diagram_id: "d-1",
  base_revision: 1,
  requester_email: "owner@example.com",
  status: "ready",
  proposal_r2_key: "proposals/job-1.json",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:01:00.000Z",
};

describe("ArchitectureJobRepository", () => {
  it("ensureJob() inserts with INSERT OR IGNORE and a queued starting status", async () => {
    const { database, statements } = databaseFor(null);
    await new ArchitectureJobRepository(database).ensureJob({
      id: "job-1",
      workflowInstanceId: "job-1",
      diagramId: "d-1",
      baseRevision: 1,
      requesterEmail: "owner@example.com",
    });
    expect(statements[0]?.sql).toContain(
      "INSERT OR IGNORE INTO architecture_jobs",
    );
    expect(statements[0]?.sql).toContain("'queued'");
    expect(statements[0]?.parameters.slice(0, 5)).toEqual([
      "job-1",
      "job-1",
      "d-1",
      1,
      "owner@example.com",
    ]);
  });

  it("findById() converts a row to the camel-cased job shape", async () => {
    const { database } = databaseFor(row);
    const job = await new ArchitectureJobRepository(database).findById("job-1");
    expect(job).toEqual({
      id: "job-1",
      workflowInstanceId: "job-1",
      diagramId: "d-1",
      baseRevision: 1,
      requesterEmail: "owner@example.com",
      status: "ready",
      proposalR2Key: "proposals/job-1.json",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
  });

  it("findById() returns null when no row exists", async () => {
    const { database } = databaseFor(null);
    const job = await new ArchitectureJobRepository(database).findById(
      "missing",
    );
    expect(job).toBeNull();
  });

  it("findActiveForDiagram() queries only non-terminal statuses", async () => {
    const { database, statements } = databaseFor(null);
    await new ArchitectureJobRepository(database).findActiveForDiagram("d-1");
    expect(statements[0]?.sql).toContain("status IN (?, ?, ?, ?, ?)");
    expect(statements[0]?.parameters).toEqual([
      "d-1",
      "queued",
      "summarizing",
      "generating",
      "validating",
      "storing",
    ]);
  });

  it("mostRecentByRequester() orders by created_at descending", async () => {
    const { database, statements } = databaseFor(row);
    const job = await new ArchitectureJobRepository(
      database,
    ).mostRecentByRequester("owner@example.com");
    expect(job?.id).toBe("job-1");
    expect(statements[0]?.sql).toContain("ORDER BY created_at DESC LIMIT 1");
  });

  it("setStatus() never overwrites a terminal row", async () => {
    const { database, statements } = databaseFor(null);
    await new ArchitectureJobRepository(database).setStatus(
      "job-1",
      "generating",
    );
    expect(statements[0]?.sql).toContain("status NOT IN ('ready', 'failed')");
    expect(statements[0]?.parameters[0]).toBe("generating");
  });

  it("setProposalKey() writes only the key column", async () => {
    const { database, statements } = databaseFor(null);
    await new ArchitectureJobRepository(database).setProposalKey(
      "job-1",
      "proposals/job-1.json",
    );
    expect(statements[0]?.sql).toContain(
      "UPDATE architecture_jobs SET proposal_r2_key = ?",
    );
  });

  it("setReady() sets status and key together, guarding against a failed job", async () => {
    const { database, statements } = databaseFor(null);
    await new ArchitectureJobRepository(database).setReady(
      "job-1",
      "proposals/job-1.json",
    );
    expect(statements[0]?.sql).toContain("status = 'ready'");
    expect(statements[0]?.sql).toContain("status != 'failed'");
  });

  it("setFailed() is idempotent — guarded against an already-terminal row", async () => {
    const { database, statements } = databaseFor(null);
    await new ArchitectureJobRepository(database).setFailed("job-1");
    expect(statements[0]?.sql).toContain("status = 'failed'");
    expect(statements[0]?.sql).toContain("status NOT IN ('ready', 'failed')");
  });
});
