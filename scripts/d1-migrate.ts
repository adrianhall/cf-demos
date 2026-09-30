#!/usr/bin/env node
// Node 26 runs this TypeScript file directly (type syntax is erased at runtime).

/**
 * @file Applies D1 migrations for a demo, resolving the database ID from that demo's Terraform
 *   outputs. This lives in the repository-root `scripts/` directory rather than inside a single
 *   demo because the logic is identical for every D1-backed demo: read a Terraform outputs JSON
 *   file, pull out the database ID, and hand it to `cf d1 migrations apply`. A demo supplies only
 *   its own paths and the target mode.
 *
 *   ## Why a script instead of a plain npm script
 *
 *   `cf d1 migrations apply` takes a **database ID** as a positional argument and rejects database
 *   names and binding names outright. That ID is not known until Terraform has created the
 *   database, so it cannot be hard-coded into `package.json`. This script reads it from the same
 *   Terraform outputs file that `cloudflare.config.ts` binds, which keeps the migrated database and
 *   the bound database provably identical instead of coincidentally equal.
 *
 *   ## Local state location
 *
 *   `--persist-to` is always passed for local runs. Without it, `cf` writes the local D1 simulation
 *   to an OS-specific user directory (on macOS `~/Library/Preferences/cloudflare/state`, which does
 *   not match the `~/.config/cloudflare/state` default shown in `cf --help`). Pinning it to the
 *   demo's own `.cloudflare/state` keeps local data inside the project, where `cf dev` reads it and
 *   where deleting the directory resets the database.
 *
 *   ## Local runs are bounded and retried once
 *
 *   Applying migrations to the local simulation occasionally hangs instead of failing: `cf` has to
 *   start a `workerd` process to host the simulated database, and that startup can wedge. There is
 *   no error to surface when it does — the command simply never returns, which stalls `pnpm start`,
 *   a CI job, or an agent run indefinitely. {@link LOCAL_TIMEOUT_MS} bounds the attempt and
 *   {@link LOCAL_ATTEMPTS} retries once, because the failure is a transient startup problem that a
 *   fresh process almost always clears. A second timeout is reported as a real failure rather than
 *   retried forever. Remote runs are deliberately **not** bounded. A remote migration's duration
 *   depends on network latency and on how much work the migration itself does against a real
 *   database, so there is no defensible timeout to pick — and killing a half-applied remote
 *   migration is worse than waiting.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cf = path.join(root, 'node_modules', 'cf', 'bin', 'cf');

/**
 * How long a single local migration attempt may run before it is abandoned.
 *
 * Local migrations run against a simulated database on this machine, with no network involved, so a
 * healthy run finishes in a second or two. Thirty seconds is therefore far beyond any legitimate
 * duration while still leaving room for a cold `workerd` start on a loaded machine — long enough
 * never to interrupt real work, short enough that a wedged process is noticed quickly rather than
 * stalling a pipeline.
 */
const LOCAL_TIMEOUT_MS = 30_000;

/**
 * How many times a local migration is attempted before giving up.
 *
 * Two: one retry. The failure being worked around is a transient process-startup hang, which a
 * fresh process clears. If a second attempt also hangs, something is genuinely wrong — a stale
 * lock, a corrupt state directory, a broken migration — and retrying further would only delay the
 * report without changing the outcome.
 */
const LOCAL_ATTEMPTS = 2;

/**
 * Shape of a single entry in a `terraform output -json` document.
 */
interface TerraformOutput {
  /**
   * The output's value. Only string outputs are supported, matching the repository's scalar-output
   * convention.
   */
  value?: unknown;
}

/**
 * Options resolved from the command line.
 */
interface MigrateOptions {
  /**
   * Terraform outputs JSON file to read the database ID from, relative to `--cwd`.
   */
  outputs: string;
  /**
   * Output name holding the D1 database ID.
   */
  outputKey: string;
  /**
   * Directory containing the numbered `.sql` migration files, relative to `--cwd`.
   */
  dir: string;
  /**
   * Demo directory every other path is resolved against.
   */
  cwd: string;
  /**
   * Apply to the local simulation rather than the real database.
   */
  local: boolean;
  /**
   * Local state directory, relative to `--cwd`. Ignored for remote runs.
   */
  persistTo: string;
}

/**
 * Convert an unknown thrown value into a message.
 *
 * @param error Value caught from a rejected promise or `catch` block.
 * @returns The error's message, or its string form when it is not an `Error`.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read a D1 database ID out of a Terraform outputs JSON file.
 *
 * @param outputsPath Absolute path to a `terraform output -json` document.
 * @param key Output name expected to hold the database ID.
 * @returns The database ID.
 * @throws {Error} When the file is missing (with the remediation command to run), is not valid
 *   JSON, lacks the named output, or holds a non-string/empty value. Each case fails loudly rather
 *   than defaulting, because silently migrating the wrong database is far worse than not
 *   migrating.
 */
async function readDatabaseId(outputsPath: string, key: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(outputsPath, 'utf8');
  } catch {
    throw new Error(
      `Could not read Terraform outputs at ${outputsPath}.\n`
        + 'Run `pnpm deploy:infra` first so Terraform writes infra/outputs.json.'
    );
  }

  let parsed: Record<string, TerraformOutput>;
  try {
    parsed = JSON.parse(raw) as Record<string, TerraformOutput>;
  } catch (error) {
    throw new Error(`${outputsPath} is not valid JSON: ${errorMessage(error)}`);
  }

  const value = parsed[key]?.value;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Terraform output "${key}" is missing or not a non-empty string in ${outputsPath}.\n`
        + `Available outputs: ${Object.keys(parsed).join(', ') || '(none)'}`
    );
  }
  return value;
}

/**
 * Error marking an attempt that was abandoned because it exceeded its time budget, as opposed to
 * one that ran and failed.
 *
 * A distinct class rather than a message match, so {@link applyMigrations} can decide whether to
 * retry by checking the type. A migration that _ran and failed_ — a syntax error in the SQL, a
 * constraint violation — must not be retried: the second attempt would fail identically and the
 * duplicated output would obscure the real cause.
 */
class MigrationTimeoutError extends Error {
  /**
   * @param timeoutMs Budget that was exceeded, quoted in the message.
   */
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs / 1_000}s`);
    this.name = 'MigrationTimeoutError';
  }
}

/**
 * Signal an entire process group, so a spawned `cf` takes its `workerd` child with it.
 *
 * Passing a negated PID to `process.kill` targets the group rather than the single process, which
 * is why the child is spawned `detached` — that is what gives it a group of its own to signal
 * without also signalling this script.
 *
 * @param pid Process ID of the group leader, or `undefined` when the child never started.
 * @param signal Signal to deliver.
 * @returns Nothing. A failure to signal is swallowed deliberately: the only realistic cause is that
 *   the group has already exited, which is the outcome being asked for anyway.
 */
function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Run `cf d1 migrations apply` once, optionally abandoning it after a time budget.
 *
 * `cf` auto-answers its "continue?" confirmation when stdin is not a TTY, so closing stdin keeps
 * this non-interactive without an extra flag; stdout and stderr are piped through so the
 * applied-migration table still appears in the build log.
 *
 * On timeout the whole **process group** is killed, not just the child. That distinction is
 * load-bearing: `cf` spawns `workerd` to host the simulated database, and killing only `cf` leaves
 * `workerd` running and still holding the local state directory — which would make the retry fail
 * for a different reason than the original hang, turning a transient problem into a permanent one.
 * The child is therefore started `detached`, which places it in a new process group, and the group
 * is signalled through the negated PID so every descendant goes with it. `SIGKILL` follows shortly
 * after `SIGTERM` because a wedged process is, by definition, one that may not be handling
 * signals.
 *
 * @param databaseId D1 database ID to migrate.
 * @param options Resolved command-line options.
 * @param timeoutMs Budget in milliseconds, or `undefined` to wait indefinitely (remote runs).
 * @returns A promise fulfilled once `cf` exits successfully.
 * @throws {MigrationTimeoutError} When the attempt exceeds `timeoutMs`.
 * @throws {Error} When `cf` cannot be spawned or exits with a non-zero status.
 */
async function runMigrationAttempt(
  databaseId: string,
  options: MigrateOptions,
  timeoutMs: number | undefined
): Promise<void> {
  const args = [cf, 'd1', 'migrations', 'apply', databaseId, '--dir', options.dir];
  if (options.local) {
    // `--persist-to` keeps the simulation inside the demo directory; see this file's header.
    args.push('--local', '--persist-to', options.persistTo);
  }
  // `cf d1 migrations apply` targets the remote database by default. Unlike Wrangler, `cf` does
  // not support a `--remote` flag; absence of `--local` is the remote form.

  const bounded = timeoutMs !== undefined;

  await new Promise<void>((resolve, reject) => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: process.env,
      // `detached` puts the child in its own process group so a timeout can take `workerd` down
      // with it. It is not `unref`'d: this script still waits for the child to finish.
      detached: bounded,
      // stdin is closed rather than inherited, and that pairs with `detached` by necessity: a
      // detached process group is not the terminal's foreground group, so reading the shared
      // stdin would earn it a `SIGTTIN` and stop it outright — a hang indistinguishable from
      // the one this timeout exists to catch, and one that only appears when run from a shell
      // with a controlling terminal. `cf`'s confirmation prompt already falls back to "yes"
      // without a TTY, so there is nothing to type anyway.
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(new Error(`cf d1 migrations apply failed: ${errorMessage(error)}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (timedOut) {
        reject(new MigrationTimeoutError(timeoutMs ?? 0));
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `cf d1 migrations apply failed: exited with `
              + `${signal === null ? `code ${code}` : `signal ${signal}`}`
          )
        );
      }
    });

    if (bounded) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid, 'SIGTERM');
        // Escalate if the group ignores the polite request, which a hung process may well do.
        killTimer = setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), 5_000);
      }, timeoutMs);
    }
  });
}

/**
 * Apply migrations, retrying a local run once if it hangs.
 *
 * Only local runs are bounded and retried; see this file's header for why a remote migration is
 * left to take as long as it needs.
 *
 * @param databaseId D1 database ID to migrate.
 * @param options Resolved command-line options.
 * @returns A promise fulfilled once the migrations have been applied.
 * @throws {Error} When a local run exceeds its budget on every attempt, or when `cf` runs and fails
 *   for any other reason — the latter on the first attempt, without retrying, because a migration
 *   that genuinely fails will fail again.
 */
async function applyMigrations(databaseId: string, options: MigrateOptions): Promise<void> {
  if (!options.local) {
    await runMigrationAttempt(databaseId, options, undefined);
    return;
  }

  for (let attempt = 1; attempt <= LOCAL_ATTEMPTS; attempt += 1) {
    try {
      await runMigrationAttempt(databaseId, options, LOCAL_TIMEOUT_MS);
      return;
    } catch (error) {
      if (!(error instanceof MigrationTimeoutError) || attempt === LOCAL_ATTEMPTS) {
        if (error instanceof MigrationTimeoutError) {
          throw new Error(
            `Local D1 migration ${error.message}, on all ${LOCAL_ATTEMPTS} attempts.\n`
              + 'This usually means a stale local simulation is wedged. Try:\n'
              + `  rm -rf ${path.join(options.cwd, options.persistTo)}\n`
              + 'then run the migration again. If it still hangs, check for an orphaned '
              + '`workerd` process holding that directory.'
          );
        }
        throw error;
      }
      process.stderr.write(
        `Local D1 migration ${error.message}; retrying (attempt ${attempt + 1} of `
          + `${LOCAL_ATTEMPTS})...\n`
      );
    }
  }
}

const program = new Command()
  .name('d1-migrate')
  .description('Apply D1 migrations using a database ID read from Terraform outputs.')
  .requiredOption('--cwd <dir>', 'Demo directory that all other paths are resolved against')
  .option('--outputs <file>', 'Terraform outputs JSON file', 'infra/outputs.json')
  .option('--output-key <name>', 'Terraform output holding the D1 database ID', 'd1_database_id')
  .option('--dir <dir>', 'Directory containing .sql migration files', 'migrations')
  .option('--local', 'Apply to the local simulation instead of the real database', false)
  .option('--persist-to <dir>', 'Local state directory', '.cloudflare/state')
  .parse();

const options = program.opts<MigrateOptions>();
const cwd = path.resolve(options.cwd);

try {
  const databaseId = await readDatabaseId(path.resolve(cwd, options.outputs), options.outputKey);
  await applyMigrations(databaseId, { ...options, cwd });
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
}
