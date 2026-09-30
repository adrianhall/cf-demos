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
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cf = path.join(root, 'node_modules', 'cf', 'bin', 'cf');

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
 * Run `cf d1 migrations apply`, streaming its output to this process's stdio.
 *
 * `cf` auto-answers its "continue?" confirmation when stdin is not a TTY, so no extra flag is
 * needed to keep this non-interactive; stdio is inherited so the applied-migration table still
 * appears in the build log.
 *
 * @param databaseId D1 database ID to migrate.
 * @param options Resolved command-line options.
 * @returns A promise fulfilled once `cf` exits successfully.
 * @throws {Error} When `cf` cannot be spawned or exits with a non-zero status.
 */
async function applyMigrations(databaseId: string, options: MigrateOptions): Promise<void> {
  const args = [cf, 'd1', 'migrations', 'apply', databaseId, '--dir', options.dir];
  if (options.local) {
    // `--persist-to` keeps the simulation inside the demo directory; see this file's header.
    args.push('--local', '--persist-to', options.persistTo);
  }
  // `cf d1 migrations apply` targets the remote database by default. Unlike Wrangler, `cf` does
  // not support a `--remote` flag; absence of `--local` is the remote form.

  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      args,
      { cwd: options.cwd, env: process.env },
      (error) => {
        if (error) {
          reject(new Error(`cf d1 migrations apply failed: ${errorMessage(error)}`));
        } else {
          resolve();
        }
      }
    );
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
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
