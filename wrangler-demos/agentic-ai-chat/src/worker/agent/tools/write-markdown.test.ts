import { describe, expect, it, vi } from "vitest";
import { writeMarkdownFile } from "./write-markdown";

/** A minimal D1 statement double whose `run()` resolves with `outcome`. */
function statementResolvingTo(outcome: () => Promise<unknown>) {
  const statement = {
    bind() {
      return statement;
    },
    run: outcome,
  };
  return statement;
}

/** A minimal D1 double whose `prepare()` always succeeds, for {@link writeMarkdownFile}'s own
 * D1 insert step. */
function successfulDatabase(): Pick<D1Database, "prepare"> {
  return {
    prepare: () =>
      statementResolvingTo(async () => ({
        meta: {
          changed_db: true,
          changes: 1,
          duration: 0,
          last_row_id: 0,
          rows_read: 0,
          rows_written: 1,
          size_after: 0,
        },
        results: [],
        success: true as const,
      })),
    // biome-ignore lint/suspicious/noExplicitAny: a minimal test double, not the real D1Database interface.
  } as any;
}

/** A D1 double whose `prepare().run()` always rejects, for the "R2 succeeded, D1 failed"
 * compensation path. */
function throwingDatabase(): Pick<D1Database, "prepare"> {
  return {
    prepare: () =>
      statementResolvingTo(async () => {
        throw new Error("simulated D1 outage");
      }),
    // biome-ignore lint/suspicious/noExplicitAny: a minimal test double, not the real D1Database interface.
  } as any;
}

describe("writeMarkdownFile", () => {
  it("writes the file to R2, persists its metadata, and returns a success result", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const bucket = { put } as unknown as R2Bucket;

    const result = await writeMarkdownFile(
      {
        bucket,
        database: successfulDatabase(),
        chatId: "chat-1",
        correlationId: "correlation-1",
      },
      { filename: "trip itinerary", content: "# Trip\n\nPack sunscreen." },
    );

    expect(result).toMatchObject({
      success: true,
      filename: "trip-itinerary.md",
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toContain("chats/chat-1/files/");
    expect(put.mock.calls[0]?.[1]).toBe("# Trip\n\nPack sunscreen.");
  });

  it("returns a failure result, without touching R2, for a filename with nothing usable", async () => {
    const put = vi.fn();
    const bucket = { put } as unknown as R2Bucket;

    const result = await writeMarkdownFile(
      {
        bucket,
        database: successfulDatabase(),
        chatId: "chat-1",
        correlationId: "correlation-1",
      },
      { filename: "...", content: "hello" },
    );

    expect(result).toEqual({
      success: false,
      error: "filename must contain at least one letter, digit, or space.",
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("returns a failure result, without touching R2, for empty content", async () => {
    const put = vi.fn();
    const bucket = { put } as unknown as R2Bucket;

    const result = await writeMarkdownFile(
      {
        bucket,
        database: successfulDatabase(),
        chatId: "chat-1",
        correlationId: "correlation-1",
      },
      { filename: "notes", content: "   " },
    );

    expect(result).toEqual({
      success: false,
      error: "content must not be empty.",
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("returns a failure result when the R2 write itself fails", async () => {
    const bucket = {
      put: vi.fn().mockRejectedValue(new Error("simulated R2 outage")),
    } as unknown as R2Bucket;

    const result = await writeMarkdownFile(
      {
        bucket,
        database: successfulDatabase(),
        chatId: "chat-1",
        correlationId: "correlation-1",
      },
      { filename: "notes", content: "hello" },
    );

    expect(result).toEqual({
      success: false,
      error: "The file could not be stored.",
    });
  });

  it("deletes the now-orphaned R2 object and returns a failure result when the D1 insert fails", async () => {
    const deleted: string[] = [];
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockImplementation(async (key: string) => {
        deleted.push(key);
      }),
    } as unknown as R2Bucket;

    const result = await writeMarkdownFile(
      {
        bucket,
        database: throwingDatabase(),
        chatId: "chat-1",
        correlationId: "correlation-1",
      },
      { filename: "notes", content: "hello" },
    );

    expect(result).toEqual({
      success: false,
      error: "The file could not be saved.",
    });
    // The orphaned object left behind by the successful R2 write is cleaned up (Section 11) --
    // never a chat_files row with no backing object, and never a leaked R2 object either.
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain("chats/chat-1/files/");
  });

  it("never leaves a downloadable file behind for a D1 failure, even if the compensating delete itself also fails", async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockRejectedValue(new Error("simulated R2 outage")),
    } as unknown as R2Bucket;

    // The original D1 failure -- the real reason this call failed -- must still be what the
    // model sees, not a confusing "cleanup failed" message masking it.
    const result = await writeMarkdownFile(
      {
        bucket,
        database: throwingDatabase(),
        chatId: "chat-1",
        correlationId: "correlation-1",
      },
      { filename: "notes", content: "hello" },
    );

    expect(result).toEqual({
      success: false,
      error: "The file could not be saved.",
    });
  });
});
