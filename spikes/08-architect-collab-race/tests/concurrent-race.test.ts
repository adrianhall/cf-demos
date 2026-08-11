/**
 * @file Phase 16 spike item 2 (docs/09C-COLLABORATIVE-EDITING.md): prototype the race directly.
 * Two clients send conflicting operations -- both targeting the same node id -- to one
 * `TestDiagramSession` instance at (as close to) the same moment as this environment allows, and
 * this file asserts the final persisted state reflects exactly one deterministic winner (the
 * operation whose synchronous mutation actually ran last) and that neither operation is silently
 * dropped.
 *
 * Per the Phase 16 text's own allowance ("two simulated WebSocket (or plain RPC-call) clients"),
 * this uses direct RPC calls on the Durable Object stub rather than real WebSocket connections --
 * the platform guarantee under test is the object's own single-threaded execution model, which a
 * WebSocket transport sits on top of but does not change; see README.md for the full reasoning.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("TestDiagramSession.applyOperation -- concurrent operations on the same node", () => {
  it("applies both operations and persists exactly the one applied last, never silently dropping either", async () => {
    const stub = env.TEST_DIAGRAM_SESSIONS.getByName(crypto.randomUUID());

    // Two "editors" targeting the same node at once: dispatched without an `await` between them,
    // so both RPC calls are in flight before either's result is known -- as close to genuinely
    // concurrent as a same-isolate test can construct. Real network latency, not this test, is
    // what would separate two browsers' actual WebSocket frames in production; the Durable
    // Object's own single-threaded execution model (Phase 16 item 1) is what has to hold up
    // regardless of exactly how close together the two arrive.
    const editorA = stub.applyOperation("shared-node", "value-from-editor-a");
    const editorB = stub.applyOperation("shared-node", "value-from-editor-b");
    const [sequenceA, sequenceB] = await Promise.all([editorA, editorB]);

    // Neither operation was silently dropped: both actually incremented the shared sequence
    // counter, and did so exactly once each -- proof the two mutations never interleaved (an
    // interleaved increment would have produced a lost update, i.e. a duplicate sequence number
    // or a gap).
    expect(new Set([sequenceA, sequenceB]).size).toBe(2);

    const appliedLog = await stub.getAppliedLog();
    expect(appliedLog).toHaveLength(2);
    expect(appliedLog.map((entry) => entry.value).sort()).toEqual(
      ["value-from-editor-a", "value-from-editor-b"].sort(),
    );

    // Ground truth for "the operation applied last": the entry with the higher sequence number,
    // independent of which call's own returned Promise happened to settle first.
    const lastApplied = appliedLog.reduce((latest, entry) =>
      entry.sequence > latest.sequence ? entry : latest,
    );

    const graph = await stub.getGraph();
    expect(graph["shared-node"]).toBe(lastApplied.value);

    const persisted = await stub.getPersisted();
    expect(persisted).not.toBeNull();
    expect(persisted?.["shared-node"]).toBe(lastApplied.value);
  });

  it("does not let two operations on different nodes interact at all", async () => {
    const stub = env.TEST_DIAGRAM_SESSIONS.getByName(crypto.randomUUID());

    const editorA = stub.applyOperation("node-a", "value-a");
    const editorB = stub.applyOperation("node-b", "value-b");
    await Promise.all([editorA, editorB]);

    const graph = await stub.getGraph();
    expect(graph).toEqual({ "node-a": "value-a", "node-b": "value-b" });

    const persisted = await stub.getPersisted();
    expect(persisted).toEqual({ "node-a": "value-a", "node-b": "value-b" });
  });
});
