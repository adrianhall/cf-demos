import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GATEWAY_EXCEPTIONS } from '../../src/worker/domain/gateway-exceptions';

/**
 * Repository-relative path of the one module permitted to talk to Workers AI.
 */
const CENTRAL_CLIENT = 'src/worker/infrastructure/ai/gateway-inference-client.ts';

/**
 * Demo root, resolved from this test file so the suite behaves identically wherever it is run.
 */
const demoRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Matches a direct use of the Workers AI binding, in any of the spellings production code could
 * plausibly use.
 */
const AI_USAGE_PATTERN = /(?:\bAI\.(?:run|gateway)\b|#ai\.(?:run|gateway)\b|\baiGatewayLogId\b)/u;

/**
 * Removes comments so the scan inspects code rather than prose.
 *
 * Several modules document the mandatory-gateway rule in their own doc comments, which is exactly
 * what a well-documented codebase should do. A scanner that could not tell a description of the
 * rule from a breach of it would penalise that.
 *
 * @param source File contents.
 * @returns The same text with block and line comments removed.
 */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/[^\n]*/gu, '');
}

/**
 * Recursively lists the demo's TypeScript and Vue source files.
 *
 * @param directory Absolute directory to walk.
 * @returns Repository-relative paths of every source file beneath it.
 * @throws {Error} When the directory cannot be read.
 */
async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(absolute)));
    } else if (/\.(?:ts|vue)$/u.test(entry.name)) {
      files.push(path.relative(demoRoot, absolute));
    }
  }

  return files;
}

describe('AI Gateway isolation', () => {
  // This is the structural guarantee behind the demo's central claim. Reviewing every diff for a
  // stray `env.AI.run()` is exactly the kind of vigilance that lapses; a failing test does not.
  it('allows only the central inference client to use the Workers AI binding', async () => {
    const offenders: string[] = [];

    for (const file of await listSourceFiles(path.join(demoRoot, 'src'))) {
      if (file === CENTRAL_CLIENT) {
        continue;
      }
      const contents = await readFile(path.join(demoRoot, file), 'utf8');
      if (AI_USAGE_PATTERN.test(stripComments(contents))) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  // An annotation without a registered exception is the signature of a bypass that skipped review.
  it('has no call-site exception annotations while the register is empty', async () => {
    const annotated: string[] = [];

    for (const file of await listSourceFiles(path.join(demoRoot, 'src'))) {
      const contents = await readFile(path.join(demoRoot, file), 'utf8');
      if (/NO_AI_GATEWAY:\s*[a-z0-9]/iu.test(contents)) {
        annotated.push(file);
      }
    }

    expect(GATEWAY_EXCEPTIONS).toHaveLength(0);
    expect(annotated).toEqual([]);
  });

  // The register must exist and state its emptiness. A missing document and an empty register look
  // the same from the outside, and only one of them is a decision.
  it('documents the empty register explicitly', async () => {
    const document = await readFile(path.join(demoRoot, 'AI-GATEWAY-EXCEPTIONS.md'), 'utf8');
    expect(document).toMatch(/The register is empty/u);
    // View Tokens must stay named as a non-exception. Without that, someone will eventually file
    // it as one, and the register will start describing local computation as a gateway bypass.
    expect(document).toMatch(/View Tokens/u);
  });
});
