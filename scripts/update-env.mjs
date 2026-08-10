#!/usr/bin/env node
/**
 * Fans a single repo-root `.env` out to a per-demo `.env` file for every
 * demo under `demos/*`, using each demo's own `.env.example` as the base
 * template.
 *
 * Layering, per demo:
 *   1. `demos/<name>/.env.example` supplies every line verbatim (including
 *      comments, which document the exact API-token permissions the demo
 *      needs).
 *   2. For every key the demo's `.env.example` declares, the repo-root
 *      `.env` value overrides it -- *except* `DEMO_NAME`, which is always
 *      demo-owned (it names the Worker) and is never overridden even if the
 *      root `.env` happens to define it.
 *   3. A key the demo does not declare is never introduced, and a key the
 *      root `.env` does not supply is left at the demo's own example value
 *      (commonly a `<from-dashboard>`-style placeholder the operator must
 *      still fill in by hand).
 *
 * New demos require no changes here: this script discovers them at runtime
 * by scanning `demos/*` for a `.env.example` file.
 *
 * Usage:
 *   npm run update-env                # generate demos/*\/.env that don't exist yet
 *   npm run update-env -- --force     # overwrite existing demos/*\/.env too
 *   npm run update-env -- --dry-run   # report what would happen; write nothing
 */

import { parseEnv } from "node:util";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keys that name a demo-specific concept rather than a shared account/zone
 * value, and must therefore never be overridden by the repo-root `.env`
 * even when a demo's `.env.example` happens to declare the same key name.
 */
export const DEMO_OWNED_KEYS = new Set(["DEMO_NAME"]);

/** Matches a `KEY=value` (optionally `export KEY=value`) assignment line. */
const ASSIGNMENT_LINE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Matches a value that is still an unfilled `<...>` placeholder. */
const PLACEHOLDER_VALUE = /^<.*>$/;

/**
 * Quotes a raw environment-variable value for insertion into a `.env` file
 * as `KEY="value"`, matching this repo's existing `.env.example` style.
 *
 * @param {string} value - The raw, unquoted value to serialize.
 * @returns {string} The value wrapped in double quotes with `\` and `"`
 *   escaped.
 * @throws {Error} If the value contains a newline, which cannot be
 *   represented on a single `.env` line.
 */
export function quoteValue(value) {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("environment values must not contain newlines");
  }
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${escaped}"`;
}

/**
 * Parses a repo-root `.env` file's contents into an override map, with
 * {@link DEMO_OWNED_KEYS} removed so callers never accidentally propagate
 * a demo-owned value.
 *
 * @param {string} rootEnvText - Raw contents of the repo-root `.env` file.
 * @returns {Record<string, string>} Key/value overrides, excluding any
 *   demo-owned keys.
 */
export function parseOverrides(rootEnvText) {
  const parsed = parseEnv(rootEnvText);
  const overrides = { ...parsed };
  for (const key of DEMO_OWNED_KEYS) {
    delete overrides[key];
  }
  return overrides;
}

/**
 * Applies override values to a demo's `.env.example` text, rewriting only
 * the right-hand side of matching assignment lines. Every comment, blank
 * line, and non-overridden assignment is preserved verbatim, so per-demo
 * documentation (such as required API-token permissions) survives.
 *
 * @param {string} exampleText - Raw contents of `demos/<name>/.env.example`.
 * @param {Record<string, string>} overrides - Key/value overrides to apply,
 *   as returned by {@link parseOverrides}.
 * @returns {{ text: string, declaredKeys: Set<string>, appliedKeys: Set<string> }}
 *   The rewritten file text, every key the example declares, and the subset
 *   of those keys that were actually overridden.
 */
export function applyOverrides(exampleText, overrides) {
  const declaredKeys = new Set();
  const appliedKeys = new Set();

  const lines = exampleText.split("\n").map((line) => {
    const match = line.match(ASSIGNMENT_LINE);
    if (!match) {
      return line;
    }

    const [, indent, exportPrefix, key] = match;
    declaredKeys.add(key);

    if (DEMO_OWNED_KEYS.has(key) || !(key in overrides)) {
      return line;
    }

    appliedKeys.add(key);
    return `${indent}${exportPrefix ?? ""}${key}=${quoteValue(overrides[key])}`;
  });

  return { text: lines.join("\n"), declaredKeys, appliedKeys };
}

/**
 * Finds every key in a generated `.env` file whose value is still an
 * unfilled `<...>`-style placeholder from the original `.env.example`.
 *
 * @param {string} envText - Contents of a generated demo `.env` file.
 * @returns {string[]} Keys whose value still matches a placeholder pattern.
 */
export function findPlaceholders(envText) {
  const parsed = parseEnv(envText);
  return Object.entries(parsed)
    .filter(([, value]) => PLACEHOLDER_VALUE.test(value))
    .map(([key]) => key);
}

/**
 * Discovers every demo directory that declares a `.env.example`.
 *
 * @param {string} demosDir - Absolute path to the repo's `demos/` directory.
 * @returns {string[]} Absolute paths to each demo directory, sorted for
 *   deterministic output.
 */
export function findDemoDirs(demosDir) {
  if (!existsSync(demosDir)) {
    return [];
  }
  return readdirSync(demosDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(demosDir, entry.name))
    .filter((dir) => existsSync(join(dir, ".env.example")))
    .sort();
}

/**
 * Generates (or reports on) a single demo's `.env` file from its
 * `.env.example` and the repo-root override map.
 *
 * @param {string} demoDir - Absolute path to the demo directory.
 * @param {Record<string, string>} overrides - Repo-root override map, as
 *   returned by {@link parseOverrides}.
 * @param {{ force?: boolean, dryRun?: boolean }} [options] - `force`
 *   overwrites an existing demo `.env`; `dryRun` reports the planned action
 *   without writing anything.
 * @returns {{
 *   demo: string,
 *   status: "written" | "skipped",
 *   appliedKeys: string[],
 *   unsuppliedKeys: string[],
 *   placeholders: string[],
 * }} A summary of what happened (or would happen) for this demo.
 */
export function generateForDemo(demoDir, overrides, options = {}) {
  const demo = demoDir.split("/").pop();
  const examplePath = join(demoDir, ".env.example");
  const envPath = join(demoDir, ".env");

  if (existsSync(envPath) && !options.force) {
    return {
      demo,
      status: "skipped",
      appliedKeys: [],
      unsuppliedKeys: [],
      placeholders: [],
    };
  }

  const exampleText = readFileSync(examplePath, "utf8");
  const { text, declaredKeys, appliedKeys } = applyOverrides(exampleText, overrides);

  const unsuppliedKeys = [...declaredKeys]
    .filter((key) => !DEMO_OWNED_KEYS.has(key) && !appliedKeys.has(key))
    .sort();
  const placeholders = findPlaceholders(text).sort();

  if (!options.dryRun) {
    writeFileSync(envPath, text);
  }

  return {
    demo,
    status: "written",
    appliedKeys: [...appliedKeys].sort(),
    unsuppliedKeys,
    placeholders,
  };
}

/**
 * CLI entry point: reads the repo-root `.env`, discovers every demo, and
 * generates each demo's `.env` per the layering rules described in this
 * module's file-level documentation. Prints a per-demo summary and an
 * overall written/skipped count; exits non-zero only if the repo-root
 * `.env` itself is missing.
 *
 * @param {string[]} argv - Process arguments (excluding `node` and the
 *   script path), e.g. `process.argv.slice(2)`.
 * @param {string} repoRoot - Absolute path to the repository root.
 * @returns {number} The process exit code.
 */
export function main(argv, repoRoot) {
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");

  const rootEnvPath = join(repoRoot, ".env");
  if (!existsSync(rootEnvPath)) {
    console.error(
      `No repo-root .env found at ${rootEnvPath}.\n` +
        "Run `cp .env.example .env` at the repo root and fill in real values first.",
    );
    return 1;
  }

  const overrides = parseOverrides(readFileSync(rootEnvPath, "utf8"));
  const demoDirs = findDemoDirs(join(repoRoot, "demos"));

  let written = 0;
  let skipped = 0;

  for (const demoDir of demoDirs) {
    const result = generateForDemo(demoDir, overrides, { force, dryRun });

    if (result.status === "skipped") {
      skipped += 1;
      console.log(`skip   ${result.demo} (.env already exists; use --force to overwrite)`);
      continue;
    }

    written += 1;
    const verb = dryRun ? "would write" : "write";
    console.log(`${verb.padEnd(6)} ${result.demo} (overrode: ${result.appliedKeys.join(", ") || "none"})`);

    if (result.unsuppliedKeys.length > 0) {
      console.log(`       not supplied by root .env: ${result.unsuppliedKeys.join(", ")}`);
    }
    if (result.placeholders.length > 0) {
      console.log(`       still a placeholder, fill in by hand: ${result.placeholders.join(", ")}`);
    }
  }

  const summaryVerb = dryRun ? "would write" : "written";
  console.log(`\n${summaryVerb}: ${written}, skipped: ${skipped}, total demos: ${demoDirs.length}`);
  return 0;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  process.exit(main(process.argv.slice(2), repoRoot));
}
