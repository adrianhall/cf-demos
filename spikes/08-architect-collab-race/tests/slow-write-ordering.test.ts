/**
 * @file Phase 16 spike item 3 (docs/09C-COLLABORATIVE-EDITING.md): confirm a slow write cannot
 * land after -- and clobber -- a faster, later-enqueued write.
 *
 * The first test in this file is the counter-example: it drives `TestDiagramSession`'s naive,
 * unchained write path (`applyOperationUnchained`) through exactly this scenario and confirms it
 * *does* exhibit the clobber bug -- proof this file's second test is not merely asserting an
 * assumption but actually catching a real failure mode the write-chain design has to avoid.
 * The second test drives the real design (`applyOperation`, `this.writeChain`) through the
 * identical scenario and confirms it does not.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("TestDiagramSession -- slow write vs. a faster, later-enqueued write", () => {
  it("counter-example: the naive, unchained write path lets a slow first write clobber a fast second write", async () => {
    const stub = env.TEST_DIAGRAM_SESSIONS.getByName(crypto.randomUUID());

    // Editor A's operation is dispatched first but its persist is deliberately slower than
    // editor B's -- exactly the shape that clobbers a correct final value if nothing enforces
    // ordering or re-reads the current state before persisting.
    const editorA = stub.applyOperationUnchained(
      "shared-node",
      "value-from-editor-a",
      50,
    );
    const editorB = stub.applyOperationUnchained(
      "shared-node",
      "value-from-editor-b",
      0,
    );
    await Promise.all([editorA, editorB]);

    // The in-memory graph itself is correct -- editor B's mutation ran after editor A's, exactly
    // like the previous test file already confirmed for the real write path. The bug is entirely
    // in what ends up "persisted": editor A's own captured-at-call-time snapshot (staled the
    // instant editor B's mutation landed) still wins the naive path's independent, unordered
    // persist, because nothing makes editor A's slow write wait its turn or re-read before it
    // finally runs.
    const graph = await stub.getGraph();
    expect(graph["shared-node"]).toBe("value-from-editor-b");

    const persistedUnchained = await stub.getPersistedUnchained();
    // This is the bug, asserted explicitly rather than merely described: the "D1" stub ends up
    // holding editor A's stale value, even though editor B's is what the in-memory graph (and a
    // real end user) actually sees.
    expect(persistedUnchained?.["shared-node"]).toBe("value-from-editor-a");
  });

  it("the real write-chain design leaves the faster write's result intact, never clobbered by the slower one", async () => {
    const stub = env.TEST_DIAGRAM_SESSIONS.getByName(crypto.randomUUID());

    // Identical scenario to the counter-example above -- editor A dispatched first with the
    // slower simulated persist, editor B dispatched second with none -- but now through
    // `applyOperation()`'s write chain.
    const editorA = stub.applyOperation("shared-node", "value-from-editor-a", 50);
    const editorB = stub.applyOperation("shared-node", "value-from-editor-b", 0);
    await Promise.all([editorA, editorB]);

    const appliedLog = await stub.getAppliedLog();
    const lastApplied = appliedLog.reduce((latest, entry) =>
      entry.sequence > latest.sequence ? entry : latest,
    );

    const graph = await stub.getGraph();
    expect(graph["shared-node"]).toBe(lastApplied.value);

    const persisted = await stub.getPersisted();
    // The key assertion: even though editor A's own link in the write chain is the one whose
    // simulated persist is slow, by the time that link actually runs it reads `this.graph`
    // fresh -- which, by then, already reflects editor B's mutation -- so the "D1" stub never
    // regresses to editor A's now-stale value at any point, including after editor A's own,
    // slower write chain link finally completes.
    expect(persisted?.["shared-node"]).toBe(lastApplied.value);
  });

  it("never exposes an intermediate window where the slow write's stale value is what's persisted", async () => {
    const stub = env.TEST_DIAGRAM_SESSIONS.getByName(crypto.randomUUID());

    const editorA = stub.applyOperation("shared-node", "value-from-editor-a", 30);
    const editorB = stub.applyOperation("shared-node", "value-from-editor-b", 0);

    // Poll `persisted` repeatedly while editor A's 30ms-delayed link is still pending, rather
    // than checking only the final state (the previous test already covers that) -- if the write
    // chain's fresh-read property only "happened to" work out in the previous test, this is what
    // would catch a transient window where editor A's own write chain link runs first, reads a
    // graph that has not yet been overwritten by editor B, and briefly persists the stale value
    // before a later link corrects it. `getPersisted()` should read as either `null` (no link has
    // completed yet) or editor B's value at every point sampled -- never editor A's.
    const observedValues: (string | undefined)[] = [];
    for (let elapsedMs = 0; elapsedMs < 40; elapsedMs += 4) {
      const sample = await stub.getPersisted();
      observedValues.push(sample?.["shared-node"]);
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    await Promise.all([editorA, editorB]);
    observedValues.push((await stub.getPersisted())?.["shared-node"]);

    expect(observedValues).not.toContain("value-from-editor-a");
    // Confirms the sampling loop actually observed the write landing at some point (i.e. this
    // assertion is not vacuously true because every sample was taken before any link completed).
    expect(observedValues).toContain("value-from-editor-b");
  });
});
