#!/usr/bin/env node
// Node runs this TypeScript file directly (type syntax is erased at runtime).

/**
 * @file Deletes this demo's deployed Worker as the first step of `pnpm teardown`.
 *
 *   ## Why a script rather than `cf workers delete <name>`
 *
 *   Every sibling demo can safely write its Worker name into `package.json`, because no other
 *   deployment on the account answers to that name. This demo cannot: it is a port deployed
 *   alongside the implementation it was ported from, which still holds the shorter name on the same
 *   account and must keep serving until cutover. A literal in a teardown script is one rename away
 *   from deleting the reference deployment — silently, non-interactively, with `--force`. So the
 *   name is _resolved_, from the same `terraform output -json` document `cloudflare.config.ts`
 *   binds. If Terraform has no state, there is nothing this demo provisioned and therefore nothing
 *   to delete; the script says so and exits successfully, which is what makes `pnpm teardown`
 *   idempotent.
 *
 *   ## Why the delete failing is not fatal
 *
 *   `terraform destroy` must still run afterwards. A Worker that was never deployed, or was already
 *   deleted by a previous teardown, produces an error that means "already in the desired state" —
 *   treating it as fatal would strand every Terraform-managed resource behind it. A genuine failure
 *   is surfaced in the output and then followed by `terraform destroy`, which will itself fail
 *   loudly if the Worker is really still bound to the database or namespace.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Demo root, resolved from this file so the script behaves the same however it is invoked.
 */
const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs a command, capturing its standard output.
 *
 * @param command Executable to run.
 * @param args Arguments to pass.
 * @returns The exit code, and whatever the command wrote to standard output.
 */
async function run(
  command: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: demoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => resolve({ code: 1, stderr: String(error), stdout: '' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stderr, stdout }));
  });
}

/**
 * Reads the Worker name Terraform recorded for this demo.
 *
 * `terraform output -raw` is used rather than reading `infra/outputs.json`, because that file is
 * written by the deploy hook and may be absent or stale on a machine that only ever ran `terraform
 * apply`. Live state is the authority for what exists to delete.
 *
 * @returns The Worker name, or `null` when Terraform holds no state for this demo — meaning nothing
 *   was provisioned and nothing needs deleting.
 */
async function resolveWorkerName(): Promise<string | null> {
  const { code, stdout } = await run('terraform', [
    '-chdir=infra',
    'output',
    '-raw',
    'worker_name'
  ]);
  const name = stdout.trim();

  if (code !== 0 || name === '') {
    return null;
  }

  return name;
}

/**
 * Deletes the deployed Worker, if there is one.
 *
 * @returns A promise fulfilled once the attempt has been made and reported. Always resolves: see
 *   this file's header for why a failed delete must not stop `terraform destroy`.
 */
async function main(): Promise<void> {
  const workerName = await resolveWorkerName();

  if (workerName === null) {
    process.stdout.write(
      'No Terraform state for this demo, so no Worker was deployed from it. Skipping delete.\n'
    );
    return;
  }

  process.stdout.write(`Deleting Worker "${workerName}" (resolved from Terraform output).\n`);

  const cf = path.join(demoRoot, 'node_modules', '.bin', 'cf');
  const { code, stdout, stderr } = await run(cf, ['workers', 'delete', workerName, '--force']);

  process.stdout.write(stdout);

  if (code !== 0) {
    // Reported, not thrown. The most common cause is a Worker that was never deployed or is
    // already gone, which is the desired end state anyway.
    process.stdout.write(
      `Worker delete did not succeed; continuing to \`terraform destroy\`, which will fail `
        + `loudly if the Worker is genuinely still bound to its resources.\n${stderr}\n`
    );
  }
}

await main();
