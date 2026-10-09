import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * @file Built-bundle contract for the editor's lazily loaded layout engine, run in the Node-based
 *   `worker` Vitest project alongside the stylesheet contract and for the same reason: this is a
 *   claim about build output that no test against source can make. ELK is roughly 1.4 MB. It exists
 *   for one optional button, so it is reached through a dynamic `import()` in
 *   `src/client/lib/auto-layout.ts` and must stay in a chunk of its own. A plain top-level import
 *   would work identically in development and in every DOM test, while making every visitor who
 *   opens a diagram download a layout engine they may never ask for — which is exactly the kind of
 *   regression only the emitted chunks can reveal.
 */

/**
 * Directory the Cloudflare Vite plugin emits built client assets into.
 */
const ASSET_DIR = path.resolve(
  import.meta.dirname,
  '../../.cloudflare/output/v0/workers/default/assets/assets'
);

/**
 * The one Worker bundle emitted by the Cloudflare Vite plugin.
 */
const WORKER_BUNDLE = path.resolve(
  import.meta.dirname,
  '../../.cloudflare/output/v0/workers/default/bundle/index.js'
);

/**
 * Marker identifying ELK's own emitted chunk.
 */
const ELK_CHUNK_MARKER = 'elk';

/**
 * Ceiling for the entry bundle, in bytes.
 *
 * Not a performance budget so much as a tripwire: ELK alone is around 1.4 MB, so an entry chunk
 * approaching this size means the lazy import has collapsed back into a static one.
 */
const MAX_ENTRY_BYTES = 1_000_000;

/**
 * Ceiling for the Worker bundle, in bytes.
 *
 * **4 MB, against a platform limit of 64 MB uncompressed, and it is a tripwire rather than a
 * budget.** The distinction decides the number. The failure worth catching is a dependency arriving
 * that has no business in a Worker — a second copy of an SDK, a browser-only library pulled in by
 * an unguarded import, the roughly 140 KB product-icon directory following a catalogue reference.
 * Each of those is hundreds of kilobytes or more and would blow straight through this. What is
 * _not_ worth catching is ordinary growth, and a ceiling set just above the current measurement
 * catches that instead: every feature trips it, every commit nudges it up, and a number that is
 * always being raised is one nobody reads. This one should hold for a long time, and when it is
 * genuinely reached that will be information.
 *
 * For scale, the figure has reached roughly 1.23 MB, and the shape of it is worth knowing because
 * it is almost entirely two dependencies rather than this demo's own code. The Worker was 308,282
 * bytes before anything imported the Agents SDK's stateless MCP handler and the MCP server SDK, and
 * 992,540 with a minimal import probe of them — so about 684 KB, two thirds of the bundle, is those
 * two libraries. Everything since has been incremental: the MCP endpoint and its graph tools, the
 * share and export tools, `generateScaffold` with the `?raw` starter templates, `fflate` for
 * server-side zipping, the pure GraphData → SVG transform, and the serialized write path, each
 * adding between 10 KB and 40 KB.
 *
 * This is Worker code; it does not change the client chunk budget above, which is a genuine
 * performance budget for bytes a visitor downloads. That is why the two contracts are separate and
 * why only one of them is tight.
 */
const MAX_WORKER_BUNDLE_BYTES = 4_000_000;

/**
 * Lists the built JavaScript chunks.
 *
 * @returns Each chunk's file name and size in bytes.
 * @throws {Error} When no build output is present, naming the command that produces it.
 */
async function readBuiltChunks(): Promise<{ name: string; bytes: number }[]> {
  let entries: string[];
  try {
    entries = await readdir(ASSET_DIR);
  } catch {
    throw new Error(
      `No build output at ${ASSET_DIR}. Run \`pnpm build\` first, or run \`pnpm check\`, which `
        + 'builds before asserting this contract.'
    );
  }

  return Promise.all(
    entries
      .filter((entry) => entry.endsWith('.js'))
      .map(async (name) => ({
        bytes: (await stat(path.join(ASSET_DIR, name))).size,
        name
      }))
  );
}

describe('built bundle contract', () => {
  let chunks: { name: string; bytes: number }[] = [];

  beforeAll(async () => {
    chunks = await readBuiltChunks();
  });

  it('emits the layout engine as a chunk of its own', () => {
    expect(
      chunks.map((chunk) => chunk.name).filter((name) => name.includes(ELK_CHUNK_MARKER))
    ).toHaveLength(1);
  });

  // The engine's own chunk is large, which is the whole reason it is separate. Every other chunk
  // has to stay far below it, because an entry bundle that had absorbed ELK would be about this
  // size too.
  it('keeps the layout engine out of every other chunk', () => {
    const others = chunks.filter((chunk) => !chunk.name.includes(ELK_CHUNK_MARKER));

    expect(others.length).toBeGreaterThan(0);
    for (const chunk of others) {
      expect(chunk.bytes).toBeLessThan(MAX_ENTRY_BYTES);
    }
  });

  // Belt and braces against the chunk being emitted but also inlined: ELK's own layout-algorithm
  // identifiers must appear in exactly one place.
  it('names the layered layout algorithm only inside that chunk', async () => {
    const containing: string[] = [];
    for (const chunk of chunks) {
      const contents = await readFile(path.join(ASSET_DIR, chunk.name), 'utf8');
      if (contents.includes('org.eclipse.elk.layered')) {
        containing.push(chunk.name);
      }
    }

    expect(containing).toHaveLength(1);
    expect(containing[0]).toContain(ELK_CHUNK_MARKER);
  });

  // Catches a dependency arriving that has no business in a Worker, not ordinary growth — see
  // `MAX_WORKER_BUNDLE_BYTES` for why the gap to the current figure is deliberately wide.
  it('keeps the Worker bundle far below the size a stray dependency would push it to', async () => {
    await expect(stat(WORKER_BUNDLE)).resolves.toMatchObject({
      size: expect.any(Number) as number
    });
    expect((await stat(WORKER_BUNDLE)).size).toBeLessThan(MAX_WORKER_BUNDLE_BYTES);
  });
});
