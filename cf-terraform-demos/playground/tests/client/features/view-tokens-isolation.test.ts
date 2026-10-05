import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTask } from '../../../src/shared/tasks';

/**
 * Demo root, resolved from this test file.
 */
const demoRoot = path.resolve(import.meta.dirname, '../../..');

/**
 * Files making up the View Tokens feature and its route view.
 */
const FEATURE_PATHS = ['src/client/features/view-tokens', 'src/client/views/ViewTokensView.vue'];

/**
 * Lists every source file belonging to the View Tokens panel.
 *
 * @returns Absolute paths of the feature's files.
 * @throws {Error} When a declared path does not exist, which means the feature moved without this
 *   guard being updated — and a guard pointed at nothing passes silently.
 */
async function featureFiles(): Promise<string[]> {
  const files: string[] = [];

  for (const relative of FEATURE_PATHS) {
    const absolute = path.join(demoRoot, relative);
    if (relative.endsWith('.vue')) {
      files.push(absolute);
      continue;
    }
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.isFile()) {
        files.push(path.join(absolute, entry.name));
      }
    }
  }

  return files;
}

/**
 * Reads the whole feature as one string.
 *
 * @returns The concatenated contents of every feature file.
 * @throws {Error} When a file cannot be read.
 */
async function featureSource(): Promise<string> {
  const files = await featureFiles();
  const contents = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  return contents.join('\n');
}

describe('View Tokens isolation', () => {
  // The panel's whole premise is that it works offline and costs nothing. A later convenience —
  // "just fetch the model list", "report usage" — would quietly break that, and the claim printed
  // on the panel would become false while everything still looked fine.
  it('makes no network call', async () => {
    const source = await featureSource();
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/XMLHttpRequest/u);
    expect(source).not.toMatch(/EventSource/u);
  });

  // No run means no entry in the cost ledger. A panel that produced a `RunReceipt` would appear
  // in the session meter with an unresolvable cost, which is exactly the "pending forever" state
  // the meter is designed to make conspicuous.
  it('creates no run and touches no cost ledger', async () => {
    const source = await featureSource();
    expect(source).not.toContain('RunReceipt');
    expect(source).not.toContain('useLedgerStore');
    expect(source).not.toContain('SessionCostLedger');
  });

  // Importing the inference port from a browser feature would be meaningless at runtime, but it
  // would signal that someone was about to add inference to a panel documented as local-only.
  it('does not reach for the inference port', async () => {
    const source = await featureSource();
    expect(source).not.toContain('InferencePort');
    expect(source).not.toContain('gateway-inference-client');
  });

  // The catalogue entry and the implementation have to agree. A panel declaring `gateway:
  // 'required'` while calling nothing would render the wrong badge; the reverse would be worse.
  it('is declared in the catalogue as performing no inference', () => {
    expect(findTask('view-tokens')?.gateway).toBe('none');
  });

  // The only panel with no model behind it, so the sidebar shows it neither the Cloudflare mark
  // nor the third-party one. Both flags false is a real state, not a missing value.
  it('advertises no hosted or third-party models, because it runs none', () => {
    expect(findTask('view-tokens')?.hosting).toEqual({ cloudflare: false, thirdParty: false });
  });
});
