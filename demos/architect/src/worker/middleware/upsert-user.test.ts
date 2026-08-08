import type { CloudflareAccessIdentity } from "@adrianhall/cloudflare-toolkit/hono";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppBindings } from "../bindings";
import { upsertUserMiddleware } from "./upsert-user";

/** A recorded D1 statement used to verify the middleware's upsert call. */
interface RecordedStatement {
  parameters: unknown[];
  sql: string;
}

/** Build the minimal D1 double needed to exercise the middleware without a real database. */
function databaseFor(): {
  database: Pick<D1Database, "prepare">;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];
  let latestStatement: RecordedStatement | undefined;
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
      if (latestStatement !== undefined) {
        latestStatement.parameters = parameters;
      }
      return statement;
    },
    first: async <T>() => null as T | null,
    raw: async <T>(): Promise<[string[], ...T[]]> => [[], [] as T],
    run: async () => ({
      meta: {
        changed_db: false,
        changes: 0,
        duration: 0,
        last_row_id: 0,
        rows_read: 0,
        rows_written: 0,
        size_after: 0,
      },
      results: [],
      success: true as const,
    }),
  };
  const database = {
    prepare(sql: string) {
      latestStatement = { parameters: [], sql };
      statements.push(latestStatement);
      return statement;
    },
  } satisfies Pick<D1Database, "prepare">;

  return { database, statements };
}

/** Build a test app that optionally sets a verified identity ahead of the middleware under test. */
function buildApp(identity?: CloudflareAccessIdentity) {
  const app = new Hono<AppBindings>();
  app.use(async (context, next) => {
    if (identity !== undefined) {
      context.set("Cloudflare_Access_Identity", identity);
    }
    await next();
  });
  app.use(upsertUserMiddleware);
  app.get("/", (context) => context.text("ok"));
  return app;
}

describe("upsertUserMiddleware", () => {
  it("upserts the users directory row for a verified identity", async () => {
    const { database, statements } = databaseFor();
    const app = buildApp({
      email: "alice@example.com",
      source: "header",
      sub: "sub-alice",
    });

    const response = await app.request(
      "/",
      {},
      { DB: database as unknown as D1Database },
    );

    expect(response.status).toBe(200);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      parameters: ["alice@example.com", expect.any(String), expect.any(String)],
      sql: expect.stringContaining("INSERT INTO users"),
    });
  });

  it("does nothing when no identity was verified", async () => {
    const { database, statements } = databaseFor();
    const app = buildApp();

    const response = await app.request(
      "/",
      {},
      { DB: database as unknown as D1Database },
    );

    expect(response.status).toBe(200);
    expect(statements).toHaveLength(0);
  });
});
