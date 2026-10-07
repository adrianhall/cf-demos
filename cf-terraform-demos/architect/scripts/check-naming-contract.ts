#!/usr/bin/env node
// Node runs this TypeScript file directly (type syntax is erased at runtime).

/**
 * @file Fails `pnpm check` when a forbidden literal would let this demo's lifecycle commands or
 *   infrastructure reach the deployment it was ported from. The rules themselves, and the reasoning
 *   behind them, live in `./naming-contract.ts`; this file only walks the demo and reports what
 *   that module finds.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  findViolations,
  formatViolations,
  isPermittedVariableDefault,
  type NamingViolation,
  shouldScan
} from './naming-contract.ts';

/**
 * Demo root, resolved from this file rather than the working directory so the check behaves the
 * same whether it is run through pnpm or directly.
 */
const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Collects every scannable file beneath a directory.
 *
 * Directories are filtered as they are encountered rather than after the fact, so an ignored tree —
 * `node_modules` above all — is never descended into at all.
 *
 * @param directory Absolute directory to walk.
 * @returns Absolute paths of every file the contract should read, in traversal order.
 * @throws {Error} When a directory cannot be read, which means the checkout is incomplete or
 *   unreadable rather than that the contract passed.
 */
async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(demoRoot, absolute).split(path.sep).join('/');

    if (entry.isDirectory()) {
      // Re-use the ignore list by testing the directory as if it were a path: a directory that is
      // itself ignored is skipped, and anything else is descended into.
      if (!shouldScan(`${relative}/placeholder.ts`)) {
        continue;
      }
      files.push(...(await collectFiles(absolute)));
    } else if (entry.isFile() && shouldScan(relative)) {
      files.push(absolute);
    }
  }

  return files;
}

/**
 * Runs the contract across the demo and exits non-zero when it is violated.
 *
 * @returns A promise fulfilled once the report has been written. The process exit code carries the
 *   result; the promise itself does not reject on a violation, because a violation is a finding
 *   rather than a crash.
 */
async function main(): Promise<void> {
  const files = await collectFiles(demoRoot);
  const violations: NamingViolation[] = [];

  for (const file of files) {
    const relative = path.relative(demoRoot, file).split(path.sep).join('/');
    const contents = await readFile(file, 'utf8');
    const lines = contents.split('\n');
    violations.push(
      ...findViolations(relative, contents).filter(
        (violation) => !isPermittedVariableDefault(violation, lines[violation.line - 1] ?? '')
      )
    );
  }

  if (violations.length > 0) {
    process.stderr.write(`${formatViolations(violations)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Naming contract passed: scanned ${files.length} files.\n`);
}

await main();
