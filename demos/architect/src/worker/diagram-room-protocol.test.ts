import { describe, expect, it } from "vitest";
import {
  parseClientFrame,
  parseTrustedIdentity,
  shouldBroadcastCursor,
} from "./diagram-room-protocol";

describe("parseClientFrame", () => {
  it("parses a well-formed cursor frame with a selection", () => {
    const frame = parseClientFrame(
      JSON.stringify({
        type: "cursor",
        x: 12,
        y: 34,
        selection: { kind: "node", id: "a" },
      }),
    );
    expect(frame).toEqual({
      type: "cursor",
      x: 12,
      y: 34,
      selection: { kind: "node", id: "a" },
    });
  });

  it("parses a cursor frame with no selection as selection: null", () => {
    expect(
      parseClientFrame(JSON.stringify({ type: "cursor", x: 1, y: 2 })),
    ).toEqual({ type: "cursor", x: 1, y: 2, selection: null });
    expect(
      parseClientFrame(
        JSON.stringify({ type: "cursor", x: 1, y: 2, selection: null }),
      ),
    ).toEqual({ type: "cursor", x: 1, y: 2, selection: null });
  });

  it("rejects a cursor frame with non-numeric or non-finite coordinates", () => {
    expect(
      parseClientFrame(JSON.stringify({ type: "cursor", x: "1", y: 2 })),
    ).toBeNull();
    expect(
      parseClientFrame(
        JSON.stringify({ type: "cursor", x: Number.POSITIVE_INFINITY, y: 2 }),
      ),
    ).toBeNull();
  });

  it("rejects a cursor frame with a malformed selection", () => {
    expect(
      parseClientFrame(
        JSON.stringify({
          type: "cursor",
          x: 1,
          y: 2,
          selection: { kind: "bogus", id: "a" },
        }),
      ),
    ).toBeNull();
    expect(
      parseClientFrame(
        JSON.stringify({ type: "cursor", x: 1, y: 2, selection: "a" }),
      ),
    ).toBeNull();
  });

  it("parses an operation envelope without validating its inner shape", () => {
    const frame = parseClientFrame(
      JSON.stringify({ type: "operation", operation: { anything: true } }),
    );
    expect(frame).toEqual({
      type: "operation",
      operation: { anything: true },
    });
  });

  it("rejects an operation envelope whose operation field is missing or not an object", () => {
    expect(parseClientFrame(JSON.stringify({ type: "operation" }))).toBeNull();
    expect(
      parseClientFrame(
        JSON.stringify({ type: "operation", operation: "not-an-object" }),
      ),
    ).toBeNull();
    expect(
      parseClientFrame(
        JSON.stringify({ type: "operation", operation: [1, 2] }),
      ),
    ).toBeNull();
  });

  it("rejects an unsupported frame type", () => {
    expect(parseClientFrame(JSON.stringify({ type: "bogus" }))).toBeNull();
  });

  it("rejects invalid JSON", () => {
    expect(parseClientFrame("not json")).toBeNull();
  });

  it("rejects a non-object JSON value", () => {
    expect(parseClientFrame(JSON.stringify(["array"]))).toBeNull();
    expect(parseClientFrame(JSON.stringify(42))).toBeNull();
  });

  it("rejects a binary frame", () => {
    expect(parseClientFrame(new ArrayBuffer(4))).toBeNull();
  });
});

describe("parseTrustedIdentity", () => {
  it("parses a well-formed trusted identity", () => {
    const headers = new Headers({
      "X-Architect-Identity": "alice@example.com",
      "X-Architect-Role": "owner",
    });
    expect(parseTrustedIdentity(headers)).toEqual({
      email: "alice@example.com",
      role: "owner",
    });
  });

  it("returns null when the identity header is missing", () => {
    const headers = new Headers({ "X-Architect-Role": "owner" });
    expect(parseTrustedIdentity(headers)).toBeNull();
  });

  it("returns null when the role header is missing or unrecognized", () => {
    expect(
      parseTrustedIdentity(
        new Headers({ "X-Architect-Identity": "alice@example.com" }),
      ),
    ).toBeNull();
    expect(
      parseTrustedIdentity(
        new Headers({
          "X-Architect-Identity": "alice@example.com",
          "X-Architect-Role": "superuser",
        }),
      ),
    ).toBeNull();
  });

  it("never trusts a client-supplied header the Worker did not itself set — this function only checks presence, not provenance", () => {
    // This module has no way to distinguish a Worker-set header from a spoofed one; the Worker
    // route (../routes/diagrams.ts) is solely responsible for stripping client-supplied values
    // first. This test documents that boundary rather than re-testing the Worker route here.
    const headers = new Headers({
      "X-Architect-Identity": "mallory@example.com",
      "X-Architect-Role": "owner",
    });
    expect(parseTrustedIdentity(headers)).toEqual({
      email: "mallory@example.com",
      role: "owner",
    });
  });
});

describe("shouldBroadcastCursor", () => {
  it("allows the very first broadcast (lastBroadcastAt of 0, an epoch far in the past)", () => {
    expect(shouldBroadcastCursor(0, 1_700_000_000_000)).toBe(true);
  });

  it("disallows a broadcast within the rate-limit window", () => {
    expect(shouldBroadcastCursor(1_000, 1_010)).toBe(false);
    expect(shouldBroadcastCursor(1_000, 1_049)).toBe(false);
  });

  it("allows a broadcast exactly at and after the rate-limit window", () => {
    expect(shouldBroadcastCursor(1_000, 1_050)).toBe(true);
    expect(shouldBroadcastCursor(1_000, 2_000)).toBe(true);
  });
});
