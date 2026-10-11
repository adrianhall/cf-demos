#!/usr/bin/env node
/**
 * @file `pnpm check:bundles`: build the SPA and both Workers, then record their sizes. The report
 *   is **observational**. It prints a table and writes `.cloudflare/bundle-report.json` (ignored,
 *   suitable as a CI artifact), but it never fails on a size: release one deliberately makes no
 *   free-tier account-limit assertions (specification §12). The figures quoted in the README come
 *   from this script.
 *
 *   ## Why it builds in its own mode
 *
 *   A `production` build reads the ignored `infra/outputs.json`, which exists only after `pnpm
 *   deploy:infra`, so it cannot run in a clean checkout or CI. The `bundles` mode reads the
 *   committed placeholder outputs instead. The emitted code is the same size: every `vite build` is
 *   a non-DEV build (development-token bypass is compiled out in both), and the modes differ only
 *   in binding values and the custom domain, which live in deployment configuration, not in the
 *   bundles.
 */

import { spawn } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

/**
 * Demo root.
 */
const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Where `cf`/Vite writes Build Output.
 */
const OUTPUT = path.join(ROOT, '.cloudflare', 'output', 'v0', 'workers');

/**
 * One measured file.
 */
interface Measured {
  /**
   * Path relative to the Build Output root.
   */
  readonly file: string;
  /**
   * Raw bytes.
   */
  readonly bytes: number;
  /**
   * Gzip-compressed bytes (level 9), an approximation of transfer size.
   */
  readonly gzipBytes: number;
}

/**
 * The report written to disk.
 */
interface Report {
  /**
   * When the report was produced.
   */
  readonly generatedAt: string;
  /**
   * The SPA chunk the browser loads first (the one `index.html` references).
   */
  readonly spaEntry: Measured | null;
  /**
   * Totals per group.
   */
  readonly totals: Record<'spaJs' | 'spaCss' | 'applicationWorker' | 'dataWorker', Measured>;
  /**
   * Every measured file.
   */
  readonly files: readonly Measured[];
}

/**
 * Run `vite build` in the `bundles` mode.
 *
 * @returns Once the build succeeded.
 * @throws {Error} When the build fails.
 */
async function build(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      path.join(ROOT, 'node_modules', '.bin', 'vite'),
      ['build', '--mode', 'bundles', '--logLevel', 'warn'],
      { cwd: ROOT, stdio: 'inherit' }
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`vite build exited with ${code ?? 'a signal'}`));
      }
    });
  });
}

/**
 * List files below a directory.
 *
 * @param directory Absolute directory.
 * @returns Absolute file paths.
 */
async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : Promise.resolve([full]);
    })
  );
  return nested.flat();
}

/**
 * Measure one file.
 *
 * @param file Absolute path.
 * @returns Its raw and gzip sizes.
 */
async function measure(file: string): Promise<Measured> {
  const content = await readFile(file);
  return {
    file: path.relative(OUTPUT, file),
    bytes: (await stat(file)).size,
    gzipBytes: gzipSync(content, { level: 9 }).length
  };
}

/**
 * Sum measurements.
 *
 * @param label Label for the total.
 * @param items Files to add up.
 * @returns The total.
 */
function total(label: string, items: readonly Measured[]): Measured {
  return items.reduce(
    (sum, item) => ({
      file: label,
      bytes: sum.bytes + item.bytes,
      gzipBytes: sum.gzipBytes + item.gzipBytes
    }),
    { file: label, bytes: 0, gzipBytes: 0 }
  );
}

/**
 * Format bytes as kB with one decimal, matching Vite's own output.
 *
 * @param bytes Byte count.
 * @returns Formatted size.
 */
function kb(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

/**
 * Build, measure, print, and write the report.
 *
 * @returns Once the report is written.
 * @throws {Error} When the build fails or its output is missing.
 */
async function main(): Promise<void> {
  await build();
  const workers = await readdir(OUTPUT);
  const dataDirectory = workers.find((name) => name.startsWith('ignite-crm-data'));
  if (!workers.includes('default') || dataDirectory === undefined) {
    throw new Error(`Unexpected Build Output layout in ${OUTPUT}: ${workers.join(', ')}`);
  }
  const all = await Promise.all(
    [
      ...(await walk(path.join(OUTPUT, 'default'))),
      ...(await walk(path.join(OUTPUT, dataDirectory)))
    ]
      .filter((file) => /\.(?:js|css|html)$/u.test(file))
      .map(measure)
  );
  const assets = all.filter((item) => item.file.startsWith('default/assets/'));
  const spaJs = assets.filter((item) => item.file.endsWith('.js'));
  const spaCss = assets.filter((item) => item.file.endsWith('.css'));
  const application = all.filter((item) => item.file.startsWith('default/bundle/'));
  const data = all.filter((item) => item.file.startsWith(`${dataDirectory}/bundle/`));
  const html = await readFile(path.join(OUTPUT, 'default', 'assets', 'index.html'), 'utf8');
  const entryName = /<script[^>]+src="\/([^"]+\.js)"/u.exec(html)?.[1];
  const spaEntry =
    entryName === undefined
      ? null
      : (spaJs.find((item) => item.file === `default/assets/${entryName}`) ?? null);

  const report: Report = {
    generatedAt: new Date().toISOString(),
    spaEntry,
    totals: {
      spaJs: total('SPA JavaScript (all chunks)', spaJs),
      spaCss: total('SPA CSS', spaCss),
      applicationWorker: total('Application Worker', application),
      dataWorker: total('Data Worker', data)
    },
    files: [...all].sort((a, b) => b.bytes - a.bytes)
  };
  const rows = [
    ...(spaEntry === null ? [] : [{ ...spaEntry, file: `SPA entry chunk (${entryName})` }]),
    ...Object.values(report.totals)
  ];
  const width = Math.max(...rows.map((row) => row.file.length));
  process.stdout.write('\nBundle sizes (observational; no limits are enforced)\n\n');
  for (const row of rows) {
    process.stdout.write(
      `  ${row.file.padEnd(width)}  ${kb(row.bytes).padStart(10)}  gzip ${kb(row.gzipBytes).padStart(9)}\n`
    );
  }
  const target = path.join(ROOT, '.cloudflare', 'bundle-report.json');
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nFull report: ${path.relative(ROOT, target)}\n`);
}

await main();
