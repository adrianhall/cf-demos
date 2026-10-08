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
 * Raised deliberately, from measurements rather than from whatever the build happened to produce.
 * The Agents SDK's stateless MCP handler and the MCP server SDK dominate the figure: the Worker was
 * 308,282 bytes before anything imported them and 992,540 with a minimal import probe. The endpoint
 * and its graph tools then took it to 1,074,373, and the share and export tools account for the
 * rest in three separately measured steps:
 *
 * - The tool functions and their schemas, 1,085,097 (+10,724);
 * - Importing `generateScaffold`, which pulls in `src/catalog.ts` and the `?raw` starter-project
 *   templates, 1,122,572 (+37,475);
 * - Importing `fflate` to zip the result server-side, 1,139,108 (+16,536).
 *
 * Both of those last two are the point of the design rather than overhead to trim: the generator is
 * shared with the browser's own export button precisely so the two produce identical projects, and
 * zipping has to happen somewhere. 1.23 MB therefore leaves roughly the same proportional allowance
 * the previous 1.1 MB ceiling left — enough for Vite's stable chunking to move, while still
 * tripping on a second accidental copy of either SDK. This is Worker code; it does not change the
 * client chunk budget above, which is why the two contracts are separate.
 */
const MAX_WORKER_BUNDLE_BYTES = 1_230_000;

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

  it('keeps the MCP server, scaffold generator and zip within their measured Worker budget', async () => {
    await expect(stat(WORKER_BUNDLE)).resolves.toMatchObject({
      size: expect.any(Number) as number
    });
    expect((await stat(WORKER_BUNDLE)).size).toBeLessThan(MAX_WORKER_BUNDLE_BYTES);
  });
});
