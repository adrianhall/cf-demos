/**
 * @file Architecture guards for the Chat panel. Chat is the first panel to call a model, so it is
 *   the first opportunity to breach the rules the whole demo rests on: that inference reaches the
 *   provider only through the gateway client, that a route never builds its own infrastructure, and
 *   that the browser never imports the Worker's domain tier. Each of those is a one-line mistake
 *   that nothing else would catch.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTask } from '../../src/tasks';
import { GATEWAY_EXCEPTIONS } from '../../src/worker/domain/gateway-exceptions';
import { modelsForTask } from '../../src/worker/domain/models';

/**
 * Demo root, resolved from this test file.
 */
const demoRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Removes comments so a scan inspects code rather than prose.
 *
 * Several modules document these very rules in their doc comments, which is what a well-documented
 * codebase should do. A scanner that could not tell a description of the rule from a breach of it
 * would push authors towards describing the rule less clearly.
 *
 * @param source File contents.
 * @returns The same text with block and line comments removed.
 */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/[^\n]*/gu, '');
}

/**
 * Recursively lists the TypeScript and Vue files beneath a directory.
 *
 * @param directory Absolute directory to walk.
 * @returns Repository-relative paths of every source file found.
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
      files.push(path.relative(demoRoot, absolute));
    }
  }

  return files;
}

describe('Chat is gateway-routed by construction', () => {
  it('is declared as requiring AI Gateway', () => {
    expect(findTask('chat')?.gateway).toBe('required');
  });

  it('has at least one reviewed model', () => {
    expect(modelsForTask('chat').length).toBeGreaterThan(0);
  });

  // The first panel to spend money must not also be the first exception. An exception is an
  // inference call that *cannot* reach the gateway; Chat's reaches it on every path.
  it('is not an entry in the gateway exception register', () => {
    expect(GATEWAY_EXCEPTIONS.some((exception) => exception.panel.includes('Chat'))).toBe(false);
  });

  it('leaves the exception register empty', () => {
    expect(GATEWAY_EXCEPTIONS).toHaveLength(0);
  });

  // A route that constructed its own client would bypass the composition root, and with it the one
  // place that guarantees the gateway identifier is bound.
  it('does not let a route construct an inference client', async () => {
    const offenders: string[] = [];

    for (const file of await listSourceFiles(path.join(demoRoot, 'src/worker/routes'))) {
      const contents = await readFile(path.join(demoRoot, file), 'utf8');
      if (contents.includes('new GatewayInferenceClient')) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  // Only the composition root may construct infrastructure. A service that reached for the
  // repository directly would make the dependency direction a suggestion rather than a rule.
  it('does not let an application service construct a repository', async () => {
    const offenders: string[] = [];

    for (const file of await listSourceFiles(path.join(demoRoot, 'src/worker/application'))) {
      const contents = await readFile(path.join(demoRoot, file), 'utf8');
      if (contents.includes('createMemoryRunRepository')) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  // The application tier must not import Hono, `env`, or a concrete binding; it depends on ports
  // only. That is what keeps every test in this suite offline.
  it('keeps the application tier free of transport and binding imports', async () => {
    const offenders: string[] = [];

    for (const file of await listSourceFiles(path.join(demoRoot, 'src/worker/application'))) {
      const contents = stripComments(await readFile(path.join(demoRoot, file), 'utf8'));
      if (/from\s+'hono/u.test(contents) || /\benv\.AI\b/u.test(contents)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('browser code does not import the Worker\u2019s server tiers', () => {
  // Model descriptors live in the Worker's domain tier and reach the browser only through
  // `/api/catalogue`. An import would invert the tier dependency and let the browser believe it
  // knows what the server will accept.
  it('does not import Worker domain, application, or infrastructure modules', async () => {
    const offenders: string[] = [];

    for (const file of await listSourceFiles(path.join(demoRoot, 'src/client'))) {
      const contents = await readFile(path.join(demoRoot, file), 'utf8');
      if (/from\s+'[^']*worker\/(?:domain|application|infrastructure)\//u.test(contents)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  // The Chat feature must reach the API through the one service module, so there is a single place
  // that describes what the browser sends.
  it('confines Chat network calls to the API service module', async () => {
    const offenders: string[] = [];
    const featureFiles = await listSourceFiles(path.join(demoRoot, 'src/client/features/chat'));

    for (const file of featureFiles) {
      const contents = await readFile(path.join(demoRoot, file), 'utf8');
      if (/\bfetch\s*\(/u.test(contents)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
