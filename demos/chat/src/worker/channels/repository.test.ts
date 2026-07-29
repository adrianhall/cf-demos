import { describe, expect, it, vi } from "vitest";
import { ChannelRepository } from "./repository";

/** A chainable D1 prepared-statement test double covering `.bind().run()/.first()` and `.all()`. */
interface FakeStatement {
  bind: (...args: unknown[]) => FakeStatement;
  all: () => Promise<unknown>;
  run: () => Promise<unknown>;
  first: () => Promise<unknown>;
}

/**
 * Build a minimal D1 database test double. `ChannelRepository` only depends on `prepare()`, so
 * this never needs a real D1 binding to unit-test the repository's own query and mapping logic.
 */
function fakeDatabase(responses: {
  all?: unknown;
  first?: unknown;
  run?: unknown;
}): Pick<D1Database, "prepare"> {
  const statement: FakeStatement = {
    all: vi.fn(async () => responses.all),
    bind: vi.fn(() => statement),
    first: vi.fn(async () => responses.first ?? null),
    run: vi.fn(async () => responses.run),
  };
  return { prepare: vi.fn(() => statement) } as unknown as Pick<
    D1Database,
    "prepare"
  >;
}

describe("ChannelRepository", () => {
  it("lists channels mapped from their snake-cased D1 rows", async () => {
    const database = fakeDatabase({
      all: {
        results: [
          {
            created_at: "2026-07-27T00:00:00.000Z",
            created_by: "system",
            name: "general",
          },
        ],
      },
    });
    const repository = new ChannelRepository(database);

    await expect(repository.list()).resolves.toEqual([
      {
        createdAt: "2026-07-27T00:00:00.000Z",
        createdBy: "system",
        name: "general",
      },
    ]);
  });

  it("creates a channel once the insert reports exactly one changed row", async () => {
    const database = fakeDatabase({ run: { meta: { changes: 1 } } });
    const repository = new ChannelRepository(database);

    const channel = await repository.create("deploys", "alice@example.com");

    expect(channel).toMatchObject({
      createdBy: "alice@example.com",
      name: "deploys",
    });
  });

  it("rejects creating a channel whose name already exists in the directory", async () => {
    const database = fakeDatabase({ run: { meta: { changes: 0 } } });
    const repository = new ChannelRepository(database);

    await expect(
      repository.create("general", "alice@example.com"),
    ).rejects.toThrow("A channel with this name already exists.");
  });

  it("reports whether removal deleted a directory row", async () => {
    const removed = fakeDatabase({ run: { meta: { changes: 1 } } });
    await expect(
      new ChannelRepository(removed).remove("deploys"),
    ).resolves.toBe(true);

    const missing = fakeDatabase({ run: { meta: { changes: 0 } } });
    await expect(
      new ChannelRepository(missing).remove("missing"),
    ).resolves.toBe(false);
  });

  it("reports whether a channel currently exists in the directory", async () => {
    const present = fakeDatabase({ first: { found: 1 } });
    await expect(
      new ChannelRepository(present).exists("general"),
    ).resolves.toBe(true);

    const absent = fakeDatabase({ first: null });
    await expect(new ChannelRepository(absent).exists("missing")).resolves.toBe(
      false,
    );
  });
});
