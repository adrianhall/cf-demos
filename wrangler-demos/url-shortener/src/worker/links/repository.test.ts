import { ProblemDetailsError } from "@adrianhall/cloudflare-toolkit/problem-details";
import { describe, expect, it, vi } from "vitest";
import { LinkRepository } from "./repository";
import { CODE_PATTERN } from "./validation";

/** One stored KV entry: the raw text value plus whatever metadata `put()` attached. */
interface StoredEntry {
  metadata?: unknown;
  value: string;
}

/**
 * Minimal in-memory stand-in for the subset of Workers KV's `KVNamespace` API
 * {@link LinkRepository} actually calls (`get`, `put`, `delete`, `list`). `list()` supports
 * a configurable page size so tests can exercise {@link LinkRepository.list}'s
 * multi-page cursor loop, not just the single-page case.
 *
 * Cast to `KVNamespace` at construction sites below — real Workers KV has many more
 * methods (`getWithMetadata`, `getMulti`, ...) that `LinkRepository` never calls, so
 * implementing only this subset and asserting the type is the standard shape for a test
 * double here, not an attempt to model the full binding.
 */
class FakeKVNamespace {
  private readonly store = new Map<string, StoredEntry>();

  constructor(private readonly pageSize: number = Number.POSITIVE_INFINITY) {}

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async put(
    key: string,
    value: string,
    options?: { metadata?: unknown },
  ): Promise<void> {
    this.store.set(key, { metadata: options?.metadata, value });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { cursor?: string; prefix?: string }): Promise<{
    cursor?: string;
    keys: { metadata?: unknown; name: string }[];
    list_complete: boolean;
  }> {
    const prefix = options?.prefix ?? "";
    const matching = [...this.store.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
    const start = options?.cursor ? Number(options.cursor) : 0;
    const page = matching.slice(start, start + this.pageSize);
    const nextIndex = start + page.length;
    const listComplete = nextIndex >= matching.length;
    return {
      cursor: listComplete ? undefined : String(nextIndex),
      keys: page.map((name) => {
        const entry = this.store.get(name);
        return entry?.metadata === undefined
          ? { name }
          : { metadata: entry.metadata, name };
      }),
      list_complete: listComplete,
    };
  }

  /** Test-only helper: seed a raw KV entry, bypassing `LinkRepository` entirely. */
  seed(key: string, value: string, metadata?: unknown): void {
    this.store.set(key, { metadata, value });
  }
}

/** Construct a {@link LinkRepository} backed by a fresh {@link FakeKVNamespace}. */
function createRepository(pageSize?: number): {
  namespace: FakeKVNamespace;
  repository: LinkRepository;
} {
  const namespace = new FakeKVNamespace(pageSize);
  return {
    namespace,
    repository: new LinkRepository(namespace as unknown as KVNamespace),
  };
}

/**
 * Reproduce `LinkRepository`'s private `generateCode()` encoding so collision tests can
 * predict the exact code a mocked `crypto.getRandomValues` byte sequence will produce.
 */
function codeForBytes(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    value += String.fromCharCode(byte);
  }
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

describe("LinkRepository.create", () => {
  it("persists a link with a generated code and matching timestamps", async () => {
    const { repository } = createRepository();
    const link = await repository.create({
      destination: "https://example.com/a",
    });

    expect(link.destination).toBe("https://example.com/a");
    expect(link.code).toMatch(CODE_PATTERN);
    expect(link.createdAt).toBe(link.updatedAt);
    expect(() => new Date(link.createdAt).toISOString()).not.toThrow();
  });

  it("retries when a generated code collides with an existing entry", async () => {
    const bytes = new Uint8Array(9).fill(1);
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation((array) => {
        (array as Uint8Array).set(bytes);
        return array;
      });

    try {
      const { namespace, repository } = createRepository();
      // Pre-seed the exact code the mocked crypto bytes will produce, forcing one collision.
      const collidingCode = codeForBytes(bytes);
      namespace.seed(`link:${collidingCode}`, "not a real stored link");

      bytes[8] = 2; // Change the bytes returned on the *second* call so the retry succeeds.
      let call = 0;
      spy.mockImplementation((array) => {
        (array as Uint8Array).set(
          call === 0 ? bytes : new Uint8Array(9).fill(2),
        );
        call += 1;
        return array;
      });

      const link = await repository.create({
        destination: "https://example.com/b",
      });
      expect(link.code).not.toBe(collidingCode);
    } finally {
      spy.mockRestore();
    }
  });

  it("gives up after exhausting every collision retry", async () => {
    const spy = vi
      .spyOn(globalThis.crypto, "getRandomValues")
      .mockImplementation((array) => {
        (array as Uint8Array).fill(9);
        return array;
      });

    try {
      const { namespace, repository } = createRepository();
      const collidingCode = codeForBytes(new Uint8Array(9).fill(9));
      namespace.seed(`link:${collidingCode}`, "occupied");

      await expect(
        repository.create({ destination: "https://example.com/c" }),
      ).rejects.toThrow("Could not allocate a unique short-link code.");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("LinkRepository.get", () => {
  it("reads back a link created through the repository", async () => {
    const { repository } = createRepository();
    const created = await repository.create({
      destination: "https://example.com/a",
    });
    await expect(repository.get(created.code)).resolves.toEqual(created);
  });

  it("throws a 404 problem for a code with no stored record", async () => {
    const { repository } = createRepository();
    await expect(repository.get("AbCdEf123456")).rejects.toBeInstanceOf(
      ProblemDetailsError,
    );
    try {
      await repository.get("AbCdEf123456");
      expect.unreachable();
    } catch (error) {
      expect((error as ProblemDetailsError).problemDetails).toMatchObject({
        detail: "Short link not found.",
        status: 404,
      });
    }
  });

  it("throws a 404 problem for a malformed stored record", async () => {
    const { namespace, repository } = createRepository();
    namespace.seed("link:AbCdEf123456", "{ not json");
    await expect(repository.get("AbCdEf123456")).rejects.toBeInstanceOf(
      ProblemDetailsError,
    );
  });

  it("throws a 404 problem when the stored record's code does not match", async () => {
    const { namespace, repository } = createRepository();
    namespace.seed(
      "link:AbCdEf123456",
      JSON.stringify({
        code: "Different0001",
        createdAt: new Date().toISOString(),
        destination: "https://example.com",
        updatedAt: new Date().toISOString(),
      }),
    );
    await expect(repository.get("AbCdEf123456")).rejects.toBeInstanceOf(
      ProblemDetailsError,
    );
  });
});

describe("LinkRepository.list", () => {
  it("returns an empty list when no links exist", async () => {
    const { repository } = createRepository();
    await expect(repository.list()).resolves.toEqual([]);
  });

  it("sorts links by most recently updated first", async () => {
    const { repository } = createRepository();
    const older = await repository.create({
      destination: "https://example.com/older",
    });
    // Ensure a distinct, later updatedAt for the second link.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = await repository.create({
      destination: "https://example.com/newer",
    });

    const links = await repository.list();
    expect(links.map((link) => link.code)).toEqual([newer.code, older.code]);
  });

  it("skips entries with no metadata or a malformed code", async () => {
    const { namespace, repository } = createRepository();
    await repository.create({ destination: "https://example.com/a" });
    namespace.seed("link:no-metadata-here", "irrelevant");
    namespace.seed("link:not-a-valid-code!!", "irrelevant", {
      createdAt: new Date().toISOString(),
      destination: "https://example.com/bad",
      updatedAt: new Date().toISOString(),
    });

    const links = await repository.list();
    expect(links).toHaveLength(1);
  });

  it("aggregates results across multiple KV list pages", async () => {
    const { repository } = createRepository(1);
    const created = await Promise.all(
      [
        "https://example.com/1",
        "https://example.com/2",
        "https://example.com/3",
      ].map((destination) => repository.create({ destination })),
    );

    const links = await repository.list();
    expect(links).toHaveLength(created.length);
    expect(new Set(links.map((link) => link.code))).toEqual(
      new Set(created.map((link) => link.code)),
    );
  });
});

describe("LinkRepository.update", () => {
  it("replaces the destination while preserving code and createdAt", async () => {
    const { repository } = createRepository();
    const created = await repository.create({
      destination: "https://example.com/old",
    });
    const updated = await repository.update(created.code, {
      destination: "https://example.com/new",
    });

    expect(updated.code).toBe(created.code);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.destination).toBe("https://example.com/new");
    await expect(repository.get(created.code)).resolves.toEqual(updated);
  });

  it("throws a 404 problem when updating a code that does not exist", async () => {
    const { repository } = createRepository();
    await expect(
      repository.update("AbCdEf123456", { destination: "https://example.com" }),
    ).rejects.toBeInstanceOf(ProblemDetailsError);
  });
});

describe("LinkRepository.delete", () => {
  it("removes a link so subsequent reads 404", async () => {
    const { repository } = createRepository();
    const created = await repository.create({
      destination: "https://example.com/a",
    });
    await repository.delete(created.code);
    await expect(repository.get(created.code)).rejects.toBeInstanceOf(
      ProblemDetailsError,
    );
  });

  it("throws a 404 problem when deleting a code that does not exist", async () => {
    const { repository } = createRepository();
    await expect(repository.delete("AbCdEf123456")).rejects.toBeInstanceOf(
      ProblemDetailsError,
    );
  });
});
