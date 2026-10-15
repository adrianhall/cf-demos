#!/usr/bin/env node
// Node 26 runs this TypeScript file directly (type syntax is erased at runtime).

/**
 * @file Regenerates `src/documentation-manifest.json` from a local Cloudflare documentation
 *   checkout.
 *
 *   ## Why the manifest is generated rather than fetched
 *
 *   The Worker that imports approved documentation has no filesystem and must not crawl. The
 *   manifest is therefore the whole interface between the documentation repository and this
 *   product: it names the approved pages and records the SHA-256 of each one at a specific
 *   revision. Reviewing the committed file is reviewing exactly the bytes the product is allowed to
 *   ground an answer in, and an import at runtime cannot reach anything the review did not cover.
 *
 *   ## Why the approved list is hard-coded here
 *
 *   The list of pages is a product decision, not a directory listing. Globbing the checkout would
 *   make an unrelated commit to the documentation repository silently widen what SalesBot claims to
 *   know. Adding a page is therefore an edit to {@link APPROVED_PAGES} and a commit, which is the
 *   review step the specification asks for. Usage:
 *
 *   ```sh
 *   pnpm generate:manifest                         # uses ~/repos/cloudflare/cloudflare-docs
 *   pnpm generate:manifest -- --checkout /path/to  # uses another checkout
 *   ```
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

/**
 * Default location of the Cloudflare documentation checkout, as named in the product introduction.
 */
const DEFAULT_CHECKOUT = path.join(process.env.HOME ?? '', 'repos/cloudflare/cloudflare-docs');

/**
 * Where the generated manifest is written, relative to this demo's directory.
 */
const MANIFEST_PATH = 'src/documentation-manifest.json';

/**
 * Repository identity recorded in the manifest.
 *
 * A fixed upstream identifier rather than the local checkout path: the manifest is committed, and
 * the absolute path of one maintainer's clone is both meaningless to everybody else and a small
 * leak of their home directory into a public file.
 */
const REPOSITORY = 'github.com/cloudflare/cloudflare-docs';

/**
 * The approved pages, as `[path, productId, title]`.
 *
 * Paths are relative to the checkout root. Each product in the seeded ownership map that has public
 * documentation is represented, so a question about any mapped product has at least one grounded
 * source.
 */
const APPROVED_PAGES: [string, string, string][] = [
  ['src/content/docs/basin/index.mdx', 'basin', 'Basin'],
  ['src/content/docs/stream/index.mdx', 'stream', 'Cloudflare Stream'],
  ['src/content/docs/images/index.mdx', 'images', 'Images'],
  ['src/content/docs/realtime/index.mdx', 'realtime-kit', 'Cloudflare Realtime'],
  ['src/content/docs/workers-ai/index.mdx', 'workers-ai', 'Cloudflare Workers AI'],
  [
    'src/content/docs/workers-ai/get-started/workers-wrangler.mdx',
    'workers-ai',
    'Workers AI bindings'
  ],
  ['src/content/docs/ai-gateway/index.mdx', 'ai-gateway', 'Cloudflare AI Gateway'],
  ['src/content/docs/ai-gateway/get-started.mdx', 'ai-gateway', 'AI Gateway: getting started'],
  ['src/content/docs/ai-search/index.mdx', 'ai-search', 'AI Search'],
  ['src/content/docs/browser-run/index.mdx', 'browser-run', 'Browser Run'],
  ['src/content/docs/agents/index.mdx', 'agents', 'Build agents on Cloudflare'],
  ['src/content/docs/email-service/index.mdx', 'email', 'Cloudflare Email Service'],
  ['src/content/docs/durable-objects/index.mdx', 'durable-objects', 'Cloudflare Durable Objects'],
  ['src/content/docs/d1/index.mdx', 'd1', 'Cloudflare D1'],
  ['src/content/docs/d1/get-started.mdx', 'd1', 'D1: getting started'],
  ['src/content/docs/kv/index.mdx', 'kv', 'Cloudflare Workers KV'],
  ['src/content/docs/hyperdrive/index.mdx', 'hyperdrive', 'Hyperdrive'],
  [
    'src/content/docs/cloudflare-for-platforms/workers-for-platforms/index.mdx',
    'workers-for-platforms',
    'Workers for Platforms'
  ]
];

/**
 * Read the short commit of a checkout.
 *
 * @param checkout Absolute path of the documentation checkout.
 * @returns The abbreviated commit hash.
 * @throws {Error} When the directory is not a Git repository or `git` is unavailable.
 */
function revisionOf(checkout: string): string {
  return execFileSync('git', ['-C', checkout, 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
}

/**
 * Hash one approved page.
 *
 * @param checkout Absolute path of the documentation checkout.
 * @param relativePath Approved page path, relative to the checkout root.
 * @returns The lowercase hexadecimal SHA-256 of the file's bytes.
 * @throws {Error} When the file is missing, which means the approved list names a page that the
 *   checkout no longer has and the list needs updating.
 */
async function hashPage(checkout: string, relativePath: string): Promise<string> {
  const content = await readFile(path.join(checkout, relativePath));
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Generate and write the manifest.
 *
 * @param checkout Absolute path of the documentation checkout.
 * @param demoDirectory Absolute path of this demo.
 * @returns A promise fulfilled once the manifest has been written.
 * @throws {Error} When the checkout cannot be read or an approved page is missing.
 */
async function generate(checkout: string, demoDirectory: string): Promise<void> {
  const revision = revisionOf(checkout);
  const entries = [];
  for (const [relativePath, productId, title] of APPROVED_PAGES) {
    entries.push({
      path: relativePath,
      productId,
      title,
      contentHash: await hashPage(checkout, relativePath)
    });
  }

  const manifest = { repository: REPOSITORY, revision, entries };
  await writeFile(
    path.join(demoDirectory, MANIFEST_PATH),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  process.stdout.write(
    `Wrote ${entries.length} approved pages at ${revision} to ${MANIFEST_PATH}\n`
  );
}

const program = new Command()
  .name('generate-manifest')
  .description('Regenerate the approved Cloudflare documentation manifest from a local checkout.')
  .option('--checkout <dir>', 'Cloudflare documentation checkout', DEFAULT_CHECKOUT)
  .parse();

const options = program.opts<{ checkout: string }>();
await generate(
  path.resolve(options.checkout),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
);
