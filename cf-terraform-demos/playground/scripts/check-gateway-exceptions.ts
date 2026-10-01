/**
 * @file Verifies that the AI Gateway exception register agrees with itself. Run by `pnpm
 *   check:gateway`. An exception must appear in three places:
 *
 *   1. a typed entry in `src/worker/domain/gateway-exceptions.ts`;
 *   2. a `NO_AI_GATEWAY: <id>` comment at the call site that skips the gateway;
 *   3. a `### <id>` section in `AI-GATEWAY-EXCEPTIONS.md`. Requiring all three is the point. Any one
 *      of them alone is easy to add and easy to forget to remove, and the failure mode is silent: a
 *      panel that quietly stops being observable while the UI still claims otherwise.
 *      Cross-checking them turns that into a failed `pnpm check`. The script also fails when a
 *      module other than the central inference client references `env.AI.run()` without an
 *      annotation, which is the specific regression this whole mechanism exists to prevent.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/**
 * Repository-relative path of the one module permitted to call Workers AI directly.
 */
const CENTRAL_CLIENT = 'src/worker/infrastructure/ai/gateway-inference-client.ts';

/**
 * Matches a call-site annotation such as `NO_AI_GATEWAY: video-callback-url`.
 */
const ANNOTATION_PATTERN = /NO_AI_GATEWAY:\s*([a-z0-9][a-z0-9-]*)/giu;

/**
 * Matches a direct use of the Workers AI binding.
 *
 * Deliberately covers several spellings — `env.AI.run(`, `context.env.AI.gateway(`, a private
 * `#ai.run(` field holding the binding, and any reference to `aiGatewayLogId` — because the thing
 * worth detecting is "this module talks to Workers AI", not one particular way of writing it. A
 * false positive here costs a reviewer thirty seconds; a false negative costs the demo its central
 * guarantee.
 */
const AI_USAGE_PATTERN = /(?:\bAI\.(?:run|gateway)\b|#ai\.(?:run|gateway)\b|\baiGatewayLogId\b)/u;

/**
 * Removes comments from source text so the binding scan looks at code only.
 *
 * Without this, a file that merely _documents_ the rule — "only this module may call
 * `env.AI.run()`" — is reported as breaking it. Prose about the invariant is exactly what a
 * well-documented codebase contains, so a scanner that cannot tell it from a call would push
 * authors towards describing the rule less clearly.
 *
 * Annotations are extracted before this runs, because `NO_AI_GATEWAY:` lives in a comment by
 * design.
 *
 * @param source File contents.
 * @returns The same text with block and line comments blanked out.
 */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/[^\n]*/gu, '');
}

/**
 * Directory holding the demo, resolved from this script's own location so the check behaves the
 * same whether it is run from the demo or from the repository root.
 */
const demoRoot = path.resolve(import.meta.dirname, '..');

/**
 * Recursively lists the TypeScript and Vue source files of the demo.
 *
 * @param directory Absolute directory to walk.
 * @returns Absolute paths of every source file found beneath it.
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
      files.push(absolute);
    }
  }

  return files;
}

/**
 * Collects the exception identifiers annotated in the demo's source, and the files that use the
 * Workers AI binding.
 *
 * @returns The annotated identifiers and the repository-relative paths of files referencing the
 *   binding.
 * @throws {Error} When a source file cannot be read.
 */
async function scanSources(): Promise<{ annotated: Set<string>; unannotatedAiUsers: string[] }> {
  const annotated = new Set<string>();
  const unannotatedAiUsers: string[] = [];

  for (const absolute of await listSourceFiles(path.join(demoRoot, 'src'))) {
    const relative = path.relative(demoRoot, absolute);
    const contents = await readFile(absolute, 'utf8');

    const fileAnnotations = [...contents.matchAll(ANNOTATION_PATTERN)].map((match) => match[1]!);
    for (const id of fileAnnotations) {
      annotated.add(id);
    }

    // The central client is expected to use the binding; every other file must justify itself
    // with an annotation in that same file. Checking per file rather than globally matters: one
    // documented exception elsewhere in the codebase must not license an un-reviewed bypass here.
    const usesBinding = AI_USAGE_PATTERN.test(stripComments(contents));
    if (usesBinding && relative !== CENTRAL_CLIENT && fileAnnotations.length === 0) {
      unannotatedAiUsers.push(relative);
    }
  }

  return { annotated, unannotatedAiUsers };
}

/**
 * Reads the exception identifiers documented in `AI-GATEWAY-EXCEPTIONS.md`.
 *
 * @returns Every identifier that has a `### <id>` section in the document.
 * @throws {Error} When the document is missing. Its absence is itself a failure: the register must
 *   exist and say "empty" rather than not exist at all.
 */
async function readDocumentedIds(): Promise<Set<string>> {
  const contents = await readFile(path.join(demoRoot, 'AI-GATEWAY-EXCEPTIONS.md'), 'utf8');
  const ids = new Set<string>();
  for (const match of contents.matchAll(/^###\s+([a-z0-9][a-z0-9-]*)\s*$/gmu)) {
    ids.add(match[1]!);
  }
  return ids;
}

/**
 * Reads the exception identifiers declared in the typed register.
 *
 * The identifiers are extracted textually rather than by importing the module, because this script
 * runs before and independently of the TypeScript build and must not depend on it succeeding. A
 * register that fails to compile should still be checkable.
 *
 * @returns Every `id:` value declared in `GATEWAY_EXCEPTIONS`.
 * @throws {Error} When the register module cannot be read.
 */
async function readRegisteredIds(): Promise<Set<string>> {
  const contents = await readFile(
    path.join(demoRoot, 'src/worker/domain/gateway-exceptions.ts'),
    'utf8'
  );
  const body = /GATEWAY_EXCEPTIONS[^=]*=\s*\[([\s\S]*?)\n\];/u.exec(contents)?.[1] ?? '';
  const ids = new Set<string>();
  for (const match of body.matchAll(/\bid:\s*'([^']+)'/gu)) {
    ids.add(match[1]!);
  }
  return ids;
}

/**
 * Compares the three sources of truth and reports every disagreement.
 *
 * @returns A list of human-readable problems; empty when the register is consistent.
 * @throws {Error} When any of the inputs cannot be read.
 */
async function findProblems(): Promise<string[]> {
  const [{ annotated, unannotatedAiUsers }, documented, registered] = await Promise.all([
    scanSources(),
    readDocumentedIds(),
    readRegisteredIds()
  ]);
  const problems: string[] = [];

  for (const file of unannotatedAiUsers) {
    problems.push(
      `${file} uses the Workers AI binding, but only ${CENTRAL_CLIENT} may do so. Route the call `
        + 'through InferencePort, or register a documented exception and annotate the call site.'
    );
  }

  for (const id of registered) {
    if (!documented.has(id)) {
      problems.push(
        `Exception "${id}" is registered in code but has no section in `
          + 'AI-GATEWAY-EXCEPTIONS.md.'
      );
    }
    if (!annotated.has(id)) {
      problems.push(
        `Exception "${id}" is registered in code but no call site carries a `
          + `NO_AI_GATEWAY: ${id} annotation. A registered exception with no call site is stale.`
      );
    }
  }

  for (const id of documented) {
    if (!registered.has(id)) {
      problems.push(
        `Exception "${id}" is documented in AI-GATEWAY-EXCEPTIONS.md but is not in `
          + 'GATEWAY_EXCEPTIONS.'
      );
    }
  }

  for (const id of annotated) {
    if (!registered.has(id)) {
      problems.push(
        `A NO_AI_GATEWAY: ${id} annotation exists, but "${id}" is not in `
          + 'GATEWAY_EXCEPTIONS. An un-registered bypass is exactly what this check exists to '
          + 'catch.'
      );
    }
  }

  return problems;
}

const problems = await findProblems();

if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`AI Gateway exception register: ${problem}\n`);
  }
  process.exit(1);
}

process.stdout.write('AI Gateway exception register is consistent.\n');
