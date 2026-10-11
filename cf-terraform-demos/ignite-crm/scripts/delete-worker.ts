#!/usr/bin/env node
/**
 * @file Delete one of this demo's two Workers before Terraform destroys bound resources. `cf
 *   workers delete --force || true` is not safe: it hides authentication failures and API outages,
 *   which would let Terraform proceed while a live Worker still holds a service or D1 binding.
 *   Search by the exact owned name first; an absent Worker is an idempotent success, but every
 *   other failure aborts teardown.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

/**
 * Worker names this demo owns; no arbitrary name can be passed to this destructive script.
 */
const OWNED_WORKERS = ['ignite-crm-application', 'ignite-crm-data'] as const;

/**
 * Run the authenticated `cf` executable without invoking a shell.
 *
 * @param args Arguments to `cf`; no credentials are passed on the command line.
 * @returns The exit code and captured stdout/stderr.
 * @throws {Error} When the executable cannot be launched.
 */
async function cf(
  args: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.resolve(import.meta.dirname, '../node_modules/.bin/cf'), [...args], {
      cwd: path.resolve(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Delete an owned Worker if present.
 *
 * @param name Exact Worker name.
 * @returns Once absent.
 * @throws {Error} On discovery, authentication, or deletion failure; teardown must stop before
 *   Terraform destroys resources a Worker might still be using.
 */
export async function deleteWorker(name: (typeof OWNED_WORKERS)[number]): Promise<void> {
  const found = await cf(['workers', 'scripts', 'search', '--name', name]);
  if (found.code !== 0) {
    throw new Error(`Could not verify whether ${name} exists: ${found.stderr}`);
  }
  const records: unknown = JSON.parse(found.stdout);
  if (
    !Array.isArray(records)
    || !records.every(
      (item) => typeof item === 'object' && item !== null && typeof item.script_name === 'string'
    )
  ) {
    throw new Error(`Unexpected Worker search response while looking for ${name}.`);
  }
  if (!records.some((item: { script_name: string }) => item.script_name === name)) {
    process.stdout.write(`${name} is already absent.\n`);
    return;
  }
  const deleted = await cf(['workers', 'delete', name, '--force']);
  if (deleted.code !== 0) {
    throw new Error(`Could not delete ${name}: ${deleted.stderr}`);
  }
  process.stdout.write(`Deleted ${name}.\n`);
}

const name = process.argv[2];
if (!OWNED_WORKERS.some((owned) => owned === name)) {
  process.stderr.write(`Expected one of: ${OWNED_WORKERS.join(', ')}.\n`);
  process.exitCode = 2;
} else {
  deleteWorker(name as (typeof OWNED_WORKERS)[number]).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
