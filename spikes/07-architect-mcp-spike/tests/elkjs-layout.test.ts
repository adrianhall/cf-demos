/**
 * @file Phase 11 spike question 3 (docs/09B-ARCHITECT-MCP.md): does `elkjs`'s layout algorithm
 * run unmodified inside `workerd`, with no DOM and no `Worker`/WASM dependency it cannot satisfy?
 *
 * **Finding: no.** This mirrors `demos/architect`'s own client-side usage
 * (`src/client/components/editor/toolbar/Toolbar.tsx`'s `applyAutoLayout`) as closely as
 * possible — the same `elkjs/lib/elk.bundled.js` entry point, the same `layered`/`ORTHOGONAL`
 * layout options, a graph shaped like a small CF-Architect diagram — and `new ELK()` throws
 * synchronously inside `workerd` (with or without the `nodejs_compat` compatibility flag; see
 * `wrangler.jsonc`). See ../REPORT.md for the full root-cause investigation and the decision this
 * drove for `docs/09B-ARCHITECT-MCP.md`'s planned `autoLayout()` (a deterministic grid-placement
 * fallback, per that document's own contingency for this exact outcome).
 *
 * This test is kept, asserting the failure, as a regression canary: if a future `elkjs`,
 * `wrangler`, or `workerd` release changes this bundling/runtime interaction, this test starts
 * failing and is the trigger to re-open the `autoLayout()` design decision, not silently miss it.
 */
import { describe, expect, it } from "vitest";

describe("elkjs inside workerd", () => {
  it("throws constructing ELK from the bundled entry point (confirmed broken, not silently degraded)", async () => {
    const ELK = (await import("elkjs/lib/elk.bundled.js")).default;

    // The failure happens synchronously inside the constructor, before any graph is even
    // supplied — see REPORT.md for why (a `require()` call nested inside elkjs's own
    // browserify-bundled `elk.bundled.js`, resolving its co-bundled `elk-worker.min.js` copy,
    // returns an object with no usable `Worker` export once re-bundled a second time by
    // Wrangler/esbuild for `workerd`).
    expect(() => new ELK()).toThrowError(/is not a constructor/);
  });
});
