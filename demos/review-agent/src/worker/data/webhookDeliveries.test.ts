import { describe, expect, it } from "vitest";
import {
  claimWebhookDelivery,
  linkWebhookDeliveryToRun,
} from "./webhookDeliveries";

/** A recorded D1 statement used to verify this repository's SQL and bound parameters. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/**
 * Build a minimal D1 double whose `first()` result for the claim's `RETURNING id` is
 * configurable per test, mirroring
 * `demos/agentic-ai-chat/src/worker/users/repository.test.ts`'s own fake D1 shape.
 */
function databaseFor(firstResult: Record<string, unknown> | null): {
  database: Pick<D1Database, "prepare">;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];

  const database = {
    prepare(sql: string) {
      const record: RecordedStatement = { parameters: [], sql };
      statements.push(record);
      const statement = {
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
          results: [] as T[],
          success: true as const,
        }),
        bind(...parameters: unknown[]) {
          record.parameters = parameters;
          return statement;
        },
        first: async <T>() => firstResult as T | null,
        raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
        run: async <T>() => ({
          meta: {
            changed_db: false,
            changes: 0,
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
      return statement;
    },
  } satisfies Pick<D1Database, "prepare">;

  return { database, statements };
}

describe("claimWebhookDelivery", () => {
  it("returns true and inserts the composite id when the delivery is new", async () => {
    const { database, statements } = databaseFor({ id: "github:delivery-1" });

    const claimed = await claimWebhookDelivery(
      database,
      "github",
      "delivery-1",
    );

    expect(claimed).toBe(true);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      parameters: ["github:delivery-1"],
      sql: expect.stringContaining("INSERT INTO review_webhook_deliveries"),
    });
    expect(statements[0]?.sql).toContain("ON CONFLICT (id) DO NOTHING");
    expect(statements[0]?.sql).toContain("RETURNING id");
  });

  it("returns false when the delivery was already claimed", async () => {
    const { database } = databaseFor(null);

    const claimed = await claimWebhookDelivery(
      database,
      "gitlab",
      "93:2026-01-16",
    );

    expect(claimed).toBe(false);
  });

  it("namespaces the composite id by provider so the same deliveryId string never collides across providers", async () => {
    const { database, statements } = databaseFor({ id: "gitlab:delivery-1" });

    await claimWebhookDelivery(database, "gitlab", "delivery-1");

    expect(statements[0]?.parameters).toEqual(["gitlab:delivery-1"]);
  });
});

describe("linkWebhookDeliveryToRun", () => {
  it("updates the delivery row's run_id using the same composite id", async () => {
    const { database, statements } = databaseFor(null);

    await linkWebhookDeliveryToRun(database, "github", "delivery-1", "run-abc");

    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      parameters: ["run-abc", "github:delivery-1"],
      sql: expect.stringContaining(
        "UPDATE review_webhook_deliveries SET run_id = ? WHERE id = ?",
      ),
    });
  });
});
