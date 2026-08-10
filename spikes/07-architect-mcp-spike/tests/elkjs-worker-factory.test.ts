/**
 * @file Follow-up probe for the same Phase 11 spike question: does supplying a directly-imported
 * `workerFactory` (bypassing `elk.bundled.js`'s own internal, nested
 * `require('./elk-worker.min.js')` call) let elkjs's real layout algorithm run inside workerd,
 * once its default constructor path (see `elkjs-layout.test.ts`) is confirmed broken?
 *
 * **Finding: no, for a different reason.** Directly importing `elkjs/lib/elk-worker.min.js` as
 * its own top-level module — the workaround this probe tries — resolves to an **empty module**
 * (`Object.keys(...)` is `[]`) once bundled a second time by Wrangler/esbuild for `workerd`. That
 * file is a large GWT (Google Web Toolkit, Java-compiled-to-JS) blob whose `module.exports =
 * {default, Worker}` assignment sits behind its own internal environment feature-detection
 * (`typeof window`/`typeof global`/`typeof self`) and closure nesting; something in that
 * combination silently no-ops under `workerd` instead of ever reaching the export assignment.
 * This second, independent failure mode is why REPORT.md's conclusion is "not currently
 * practical to work around," not "one specific bug to patch."
 */
import { describe, expect, it } from "vitest";

describe("elkjs inside workerd with a directly-imported worker module", () => {
  it("resolves elk-worker.min.js to an empty module (no Worker export survives re-bundling)", async () => {
    const workerModule = (await import(
      // @ts-expect-error -- elkjs ships no type declarations for this sub-path beyond the bare
      // re-exported type; the real runtime export is a synchronous "fake worker" class.
      "elkjs/lib/elk-worker.min.js"
    )) as Record<string, unknown>;

    // Confirmed empty: neither `default` nor `Worker` survives being re-bundled for workerd.
    expect(Object.keys(workerModule)).toHaveLength(0);
    expect(workerModule.Worker).toBeUndefined();
  });
});
