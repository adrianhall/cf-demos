/**
 * @file Architecture guards for every delivered inference panel. Each panel that calls a model is
 *   another opportunity to breach the rules the whole demo rests on: that inference reaches the
 *   provider only through the gateway client, that a route never builds its own infrastructure, and
 *   that the browser never imports the Worker's domain tier. Each of those is a one-line mistake
 *   that nothing else would catch. The panel list is read from the catalogue rather than written
 *   out here, so a panel delivered in a later phase inherits these guards automatically instead of
 *   needing to be remembered.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTask, TASK_DESCRIPTORS } from '../../src/tasks';
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

/**
 * Every panel that is built and performs inference.
 *
 * Driven from the catalogue rather than a hand-written list, so a panel delivered in a later phase
 * is covered by these guards the moment it is marked available.
 */
const deliveredInferencePanels = TASK_DESCRIPTORS.filter(
  (task) => task.availability === 'available' && task.gateway === 'required'
);

describe.each(deliveredInferencePanels.map((task) => [task.name, task] as const))(
  '%s is gateway-routed by construction',
  (_name, task) => {
    it('is declared as requiring AI Gateway', () => {
      expect(findTask(task.id)?.gateway).toBe('required');
    });

    it('has at least one reviewed model', () => {
      expect(modelsForTask(task.id).length).toBeGreaterThan(0);
    });

    // A panel that spends money must not become an exception. An exception is an inference call
    // that *cannot* reach the gateway; every delivered panel's reaches it on every path.
    it('is not an entry in the gateway exception register', () => {
      expect(GATEWAY_EXCEPTIONS.some((exception) => exception.panel.includes(task.name))).toBe(
        false
      );
    });
  }
);

describe('the delivered inference panels', () => {
  // A guard on the guards: if this ever read zero, the suite above would pass by testing nothing.
  it('number at least two by this phase', () => {
    expect(deliveredInferencePanels.length).toBeGreaterThanOrEqual(2);
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

  // A feature must reach the API through the one service module, so there is a single place that
  // describes what the browser sends. Every feature directory is scanned, so a panel added later
  // cannot quietly open its own `fetch`.
  it('confines feature network calls to the API service module', async () => {
    const offenders: string[] = [];

    for (const file of await listSourceFiles(path.join(demoRoot, 'src/client/features'))) {
      const contents = stripComments(await readFile(path.join(demoRoot, file), 'utf8'));
      if (/\bfetch\s*\(/u.test(contents)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('failure diagnostics', () => {
  // The regression that made a deployed 502 undiagnosable: the inference client caught the
  // provider's error with a bare `catch {}` and threw a sanitised one, discarding the only
  // description of what had actually gone wrong. Sanitising for the browser is right; discarding
  // the cause is not, and the two are easy to conflate.
  it('does not discard a thrown cause around a provider call', async () => {
    const client = 'src/worker/infrastructure/ai/gateway-inference-client.ts';
    const contents = stripComments(await readFile(path.join(demoRoot, client), 'utf8'));

    // Scoped to `try` blocks that actually invoke the binding. A bare `catch` is legitimate when
    // parsing one malformed SSE frame, where the cause carries no information a reader of the log
    // could act on; it is not legitimate around a call whose failure is the thing being diagnosed.
    const providerCalls = contents.matchAll(
      /try\s*\{(?<body>[^}]*#ai\.(?:run|gateway)[^}]*)\}\s*catch(?<binding>\s*\{|\s*\()/gsu
    );

    const offenders = [...providerCalls].filter(
      (match) => !match.groups?.['binding']?.includes('(')
    );

    expect(offenders.map((match) => match[0].slice(0, 80))).toEqual([]);
  });

  // Every provider call must be able to say why it failed. A client constructed without a logger
  // is valid for a unit test, but the composition root has to supply one or the deployed Worker is
  // blind in exactly the situation the logger exists for.
  it('gives the inference client a logger in the composition root', async () => {
    const contents = stripComments(
      await readFile(path.join(demoRoot, 'src/worker/index.ts'), 'utf8')
    );

    expect(contents).toMatch(/new GatewayInferenceClient\(\{[^}]*logger:/su);
  });

  it('gives the Create Image service a logger in the composition root', async () => {
    const contents = stripComments(
      await readFile(path.join(demoRoot, 'src/worker/index.ts'), 'utf8')
    );

    expect(contents).toMatch(/new CreateImageService\(\{[^}]*logger:/su);
  });

  // A structured log must never carry the verified email: it belongs in AI Gateway metadata, which
  // is a different retention domain with different access control. The literal field name is the
  // thing to watch for, since that is how it would be added.
  it('does not log the verified identity email anywhere in the Worker', async () => {
    const offenders: string[] = [];

    for (const file of await listSourceFiles(path.join(demoRoot, 'src/worker'))) {
      const contents = stripComments(await readFile(path.join(demoRoot, file), 'utf8'));
      // Matches a log call whose context object mentions an email field.
      if (/logger[^;]*\b(?:warn|info|error)\s*\([^;]*\b(?:email|userEmail)\b/su.test(contents)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('media handling', () => {
  // The specification requires generated media to stay transient in this phase: no R2 bucket, no
  // retention policy, no cleanup step at teardown. Introducing storage to make a panel work is a
  // decision that has to be designed explicitly, so it should not be possible to slip in.
  it('persists no generated media to a storage product', async () => {
    const offenders: string[] = [];
    const directories = ['src/worker', 'src/client'];

    for (const directory of directories) {
      for (const file of await listSourceFiles(path.join(demoRoot, directory))) {
        const contents = stripComments(await readFile(path.join(demoRoot, file), 'utf8'));
        if (/\benv\.(?:R2|BUCKET|MEDIA)\b|\.put\s*\(/u.test(contents)) {
          offenders.push(file);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('declares no R2 binding in the Worker configuration', async () => {
    const config = await readFile(path.join(demoRoot, 'cloudflare.config.ts'), 'utf8');
    expect(stripComments(config)).not.toMatch(/r2_buckets|R2Bucket/u);
  });

  // The media type a browser is given decides how it treats the payload, so it must come from the
  // bytes rather than from anything the provider declared. Confining that judgement to one module
  // means there is a single place to audit.
  it('determines an image media type only in the sniffing module', async () => {
    const offenders: string[] = [];
    const sniffer = 'src/worker/domain/image-bytes.ts';

    for (const file of await listSourceFiles(path.join(demoRoot, 'src/worker'))) {
      if (file === sniffer) {
        continue;
      }
      const contents = stripComments(await readFile(path.join(demoRoot, file), 'utf8'));
      // A literal image media type anywhere else would mean a second place deciding what a payload
      // is, which is exactly the duplication that lets one copy fall behind.
      if (/['"]image\/(?:png|jpeg|webp|svg\+xml|gif)['"]/u.test(contents)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
