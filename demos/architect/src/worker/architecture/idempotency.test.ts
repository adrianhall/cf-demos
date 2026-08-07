import { describe, expect, it } from "vitest";
import { deriveIdempotentJobId } from "./idempotency";

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe("deriveIdempotentJobId", () => {
  it("is deterministic for the same diagram, requester, and key", async () => {
    const first = await deriveIdempotentJobId("d-1", "a@example.com", "key-1");
    const second = await deriveIdempotentJobId("d-1", "a@example.com", "key-1");
    expect(first).toBe(second);
  });

  it("produces a UUID-shaped identifier", async () => {
    const id = await deriveIdempotentJobId("d-1", "a@example.com", "key-1");
    expect(id).toMatch(UUID_SHAPE);
  });

  it("differs when the diagram id differs", async () => {
    const a = await deriveIdempotentJobId("d-1", "a@example.com", "key-1");
    const b = await deriveIdempotentJobId("d-2", "a@example.com", "key-1");
    expect(a).not.toBe(b);
  });

  it("differs when the requester differs", async () => {
    const a = await deriveIdempotentJobId("d-1", "a@example.com", "key-1");
    const b = await deriveIdempotentJobId("d-1", "b@example.com", "key-1");
    expect(a).not.toBe(b);
  });

  it("differs when the idempotency key differs", async () => {
    const a = await deriveIdempotentJobId("d-1", "a@example.com", "key-1");
    const b = await deriveIdempotentJobId("d-1", "a@example.com", "key-2");
    expect(a).not.toBe(b);
  });
});
