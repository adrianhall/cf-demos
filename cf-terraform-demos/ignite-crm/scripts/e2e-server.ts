#!/usr/bin/env node
/**
 * @file Start the application for the offline Playwright journeys. Resets a dedicated local state
 *   directory, applies the data and local-only seed migrations to it with the repository's
 *   migration helper, then runs `cf dev` against it on the given port until Playwright stops it. A
 *   dedicated directory keeps journeys reproducible (every run starts from the same seed) and keeps
 *   them away from the developer's own `pnpm start` data in `.cloudflare/state`.
 */

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/**
 * Demo root.
 */
const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The E2E-only local state directory, relative to the demo root.
 */
const STATE = '.cloudflare/e2e-state';

/**
 * Run a command to completion, inheriting stderr.
 *
 * @param command Executable.
 * @param args Arguments.
 * @returns Once it exits successfully.
 * @throws {Error} When it exits with a non-zero code.
 */
function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? 'a signal'}`))
    );
  });
}

/**
 * Apply one migration directory to the E2E state.
 *
 * @param directory Migrations directory.
 * @returns Once applied.
 * @throws {Error} When the helper fails.
 */
function migrate(directory: string): Promise<void> {
  return run(process.execPath, [
    path.join(ROOT, '..', '..', 'scripts', 'd1-migrate.ts'),
    '--cwd',
    '.',
    '--outputs',
    'infra/local-outputs.json',
    '--local',
    '--persist-to',
    STATE,
    '--dir',
    directory
  ]);
}

const port = process.argv[2] ?? '5199';
await rm(path.join(ROOT, STATE), { recursive: true, force: true });
await migrate('migrations/data');
await migrate('migrations/seed');

const server = spawn(
  path.join(ROOT, 'node_modules', '.bin', 'cf'),
  ['dev', '--persist-to', STATE, '--port', port],
  { cwd: ROOT, stdio: 'inherit' }
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.kill(signal));
}
server.on('exit', (code) => process.exit(code ?? 0));
