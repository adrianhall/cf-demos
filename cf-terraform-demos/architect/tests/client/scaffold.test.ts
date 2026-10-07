import { describe, expect, it } from 'vitest';
import { NODE_TYPE_MAP } from '../../src/catalog.ts';
import {
  generateScaffold,
  type ScaffoldInput,
  toBindingName,
  toProjectName,
  toResourceName
} from '../../src/client/lib/scaffold.ts';

/**
 * @file Covers the project-scaffold generator. It is pure, so everything about it is testable here
 *   — which matters, because the files it produces are the one artifact of this demo that somebody
 *   takes away and tries to run. A generated project that does not build is a worse outcome than
 *   one that was never offered. The generated project is `cf`-native rather than Wrangler-based,
 *   which is a deliberate departure from the application this was ported from; see
 *   `src/client/lib/scaffold.ts`. The assertions below pin that choice, so a reversion fails rather
 *   than quietly shipping a starter project built on the superseded tool.
 */

/**
 * A fixed clock, so the generated compatibility date can be asserted exactly.
 */
const FIXED_NOW = new Date(Date.UTC(2026, 4, 17, 12, 0, 0));

/**
 * Builds a scaffold input with sensible defaults.
 *
 * @param overrides Fields to replace.
 * @returns The input.
 */
function makeInput(overrides: Partial<ScaffoldInput> = {}): ScaffoldInput {
  return {
    edges: overrides.edges ?? [],
    nodes: overrides.nodes ?? [],
    title: overrides.title ?? 'Test Project'
  };
}

/**
 * Generates a scaffold and returns one of its files.
 *
 * @param nodes Nodes to generate from.
 * @param path File to read out of the result.
 * @param title Diagram title.
 * @returns The file's contents.
 * @throws {Error} When the generator did not produce that file, so a later assertion cannot fail
 *   against `undefined` for an unrelated reason.
 */
function generatedFile(
  nodes: { label: string; typeId: string }[],
  path: string,
  title = 'Test Project'
): string {
  const files = generateScaffold(makeInput({ nodes, title }), FIXED_NOW);
  const contents = files.get(path);
  if (contents === undefined) {
    throw new Error(
      `The generator produced no ${path}. It produced: ${[...files.keys()].join(', ')}`
    );
  }
  return contents;
}

describe('toBindingName', () => {
  it('converts a label to SCREAMING_SNAKE_CASE', () => {
    expect(toBindingName('My D1 Database')).toBe('MY_D1_DATABASE');
  });

  // Dropped rather than replaced: a binding name becomes a property on `env`, and an underscore
  // per stray character would make it unreadable.
  it('drops characters that cannot appear in an identifier', () => {
    expect(toBindingName('user-data (prod)')).toBe('USERDATA_PROD');
  });

  it('collapses runs of whitespace', () => {
    expect(toBindingName('  Hello   World  ')).toBe('HELLO_WORLD');
  });

  it.each([
    ['an empty label', ''],
    ['an all-punctuation label', '!!!']
  ])('falls back to a usable name for %s', (_description, label) => {
    expect(toBindingName(label)).toBe('BINDING');
  });
});

describe('toResourceName', () => {
  it('converts a label to lowercase-kebab-case', () => {
    expect(toResourceName('My D1 Database')).toBe('my-d1-database');
  });

  it.each([
    ['an empty label', ''],
    ['an all-punctuation label', '!!!']
  ])('falls back to a usable name for %s', (_description, label) => {
    expect(toResourceName(label)).toBe('resource');
  });
});

describe('toProjectName', () => {
  it('converts a title to lowercase-kebab-case', () => {
    expect(toProjectName('My Vanilla App')).toBe('my-vanilla-app');
  });

  // A visitor who titled a diagram `my-api` meant that name, rather than that name spelled
  // differently.
  it('keeps a hyphen the author wrote themselves', () => {
    expect(toProjectName('my-api')).toBe('my-api');
  });

  it.each([
    ['an empty title', ''],
    ['an all-punctuation title', '!!!']
  ])('falls back to a usable name for %s', (_description, title) => {
    expect(toProjectName(title)).toBe('my-cloudflare-project');
  });
});

describe('a diagram with nothing to generate', () => {
  // An empty result is how the caller knows to refuse the export rather than handing somebody an
  // archive with nothing in it.
  it('produces no files for an empty diagram', () => {
    expect(generateScaffold(makeInput(), FIXED_NOW).size).toBe(0);
  });

  // An external actor is not something Cloudflare provisions, so there is nothing to configure.
  it('produces no files for a diagram of external actors only', () => {
    const files = generateScaffold(
      makeInput({
        nodes: [
          { label: 'Some API', typeId: 'external-api' },
          { label: 'Browser', typeId: 'client-browser' }
        ]
      }),
      FIXED_NOW
    );

    expect(files.size).toBe(0);
  });

  it('ignores a node whose type the catalogue does not define', () => {
    const files = generateScaffold(
      makeInput({ nodes: [{ label: 'Mystery', typeId: 'not-a-real-type' }] }),
      FIXED_NOW
    );

    expect(files.size).toBe(0);
  });
});

describe('the generated project targets the cf control plane', () => {
  // The deliberate departure from the source, pinned so a reversion fails here rather than
  // quietly shipping a starter project built on the tool this demo exists to supersede.
  it('configures the Worker in a typed cloudflare.config.ts', () => {
    const files = generateScaffold(
      makeInput({ nodes: [{ label: 'API Worker', typeId: 'worker' }] }),
      FIXED_NOW
    );

    expect(files.has('cloudflare.config.ts')).toBe(true);
    expect(files.has('wrangler.toml')).toBe(false);
    expect(files.has('wrangler.jsonc')).toBe(false);
  });

  it('declares its bindings through defineConfig and defineWorker', () => {
    const config = generatedFile(
      [{ label: 'API Worker', typeId: 'worker' }],
      'cloudflare.config.ts'
    );

    expect(config).toContain("from 'cf/config'");
    expect(config).toContain('defineConfig({');
    expect(config).toContain('defineWorker({');
  });

  it('names no Wrangler command in any generated file', () => {
    const files = generateScaffold(
      makeInput({
        nodes: [
          { label: 'API Worker', typeId: 'worker' },
          { label: 'Main Database', typeId: 'd1' }
        ]
      }),
      FIXED_NOW
    );

    for (const [path, contents] of files) {
      expect(contents, `${path} must not invoke Wrangler`).not.toMatch(/\bwrangler\b/iu);
    }
  });

  it('pins the compatibility date the generated code was written against', () => {
    const config = generatedFile(
      [{ label: 'API Worker', typeId: 'worker' }],
      'cloudflare.config.ts'
    );

    expect(config).toContain("compatibilityDate: '2026-05-17'");
  });

  // The correct default for a project being created now: it pins the runtime behaviour the
  // generated code was written against, and the reader advances it deliberately later.
  it('dates the project from the real clock when none is given', () => {
    const files = generateScaffold(makeInput({ nodes: [{ label: 'Worker', typeId: 'worker' }] }));
    const config = files.get('cloudflare.config.ts') as string;

    expect(config).toContain(`compatibilityDate: '${new Date().toISOString().slice(0, 10)}'`);
  });
});

describe('a plain Worker', () => {
  const nodes = [{ label: 'API Worker', typeId: 'worker' }];

  it('names the project and the Worker from the diagram title', () => {
    const config = generatedFile(nodes, 'cloudflare.config.ts', 'My Vanilla App');

    expect(config).toContain("const PROJECT_NAME = 'my-vanilla-app'");
  });

  it('points the entry point at the plain Worker source', () => {
    const config = generatedFile(nodes, 'cloudflare.config.ts');

    expect(config).toContain("entrypoint: './src/index.ts'");
  });

  it('generates a runnable entry point', () => {
    expect(generatedFile(nodes, 'src/index.ts')).toContain('async fetch(');
  });

  it('generates package scripts for the cf lifecycle', () => {
    const manifest = JSON.parse(generatedFile(nodes, 'package.json', 'My Vanilla App')) as {
      name: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(manifest.name).toBe('my-vanilla-app');
    expect(manifest.scripts.dev).toBe('cf dev');
    expect(manifest.scripts['deploy:cf']).toBe('cf deploy');
    expect(manifest.scripts.deploy).toBe('run-s deploy:cf');
    expect(manifest.devDependencies.cf).toBeDefined();
  });

  it('generates a TypeScript configuration and a README', () => {
    const files = generateScaffold(makeInput({ nodes }), FIXED_NOW);

    expect(files.has('tsconfig.json')).toBe(true);
    expect(files.has('README.md')).toBe(true);
  });

  it('omits the database files entirely', () => {
    const files = generateScaffold(makeInput({ nodes }), FIXED_NOW);

    for (const path of [
      'drizzle.config.ts',
      'src/db/schema.ts',
      'src/db/client.ts',
      'migrations/0001_initial.sql'
    ]) {
      expect(files.has(path)).toBe(false);
    }
  });
});

describe('a Hono Worker with a database and a namespace', () => {
  const nodes = [
    { label: 'API', typeId: 'worker-hono' },
    { label: 'Main Database', typeId: 'd1' },
    { label: 'Cache Store', typeId: 'kv' }
  ];

  // The binding is named from the node's own label, so the generated configuration reads like
  // the diagram rather than like a list of products.
  it('names each binding after the node the visitor labelled', () => {
    const config = generatedFile(nodes, 'cloudflare.config.ts');

    expect(config).toContain('MAIN_DATABASE: bindings.d1(');
    expect(config).toContain('CACHE_STORE: bindings.kv(');
    expect(config).toContain("name: 'main-database'");
  });

  it('comments each binding with the label it came from', () => {
    expect(generatedFile(nodes, 'cloudflare.config.ts')).toContain('// Main Database');
  });

  // Deliberately invalid, so a generated project fails loudly on first deploy rather than
  // silently binding to nothing.
  it('leaves an obvious placeholder where an id must be filled in', () => {
    const config = generatedFile(nodes, 'cloudflare.config.ts');

    expect(config).toContain('<INSERT_DATABASE_ID>');
    expect(config).toContain('<INSERT_NAMESPACE_ID>');
  });

  it('generates the Hono entry point', () => {
    expect(generatedFile(nodes, 'src/index.ts')).toContain('Hono');
  });

  it('adds the database tooling and its scripts', () => {
    const manifest = JSON.parse(generatedFile(nodes, 'package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(manifest.dependencies.hono).toBeDefined();
    expect(manifest.dependencies['drizzle-orm']).toBeDefined();
    expect(manifest.devDependencies['drizzle-kit']).toBeDefined();
    expect(manifest.scripts['db:generate']).toBe('drizzle-kit generate');
    expect(manifest.scripts['db:migrate:local']).toContain('MAIN_DATABASE');
    expect(manifest.scripts['deploy:db']).toContain('MAIN_DATABASE');
  });

  // Database before code, so a deployed Worker never meets a schema it predates. This is the
  // same ordering rule this demo's own lifecycle follows.
  it('migrates the database before uploading the Worker', () => {
    const manifest = JSON.parse(generatedFile(nodes, 'package.json')) as {
      scripts: Record<string, string>;
    };
    const steps = (manifest.scripts.deploy ?? '').replace('run-s ', '').split(/\s+/u);

    expect(steps.indexOf('deploy:db')).toBeLessThan(steps.indexOf('deploy:cf'));
  });

  it('includes the schema, the client and a migration stub', () => {
    const files = generateScaffold(makeInput({ nodes }), FIXED_NOW);

    expect(files.has('drizzle.config.ts')).toBe(true);
    expect(files.has('src/db/schema.ts')).toBe(true);
    expect(files.has('src/db/client.ts')).toBe(true);
    expect(files.get('migrations/0001_initial.sql')).toContain('CREATE TABLE');
  });
});

describe('an Astro Worker with a bucket', () => {
  const nodes = [
    { label: 'Web App', typeId: 'worker-astro' },
    { label: 'Asset Bucket', typeId: 'r2' }
  ];

  it('generates the Astro project files instead of a Worker entry point', () => {
    const files = generateScaffold(makeInput({ nodes }), FIXED_NOW);

    expect(files.has('astro.config.mjs')).toBe(true);
    expect(files.has('src/pages/index.astro')).toBe(true);
    expect(files.has('src/index.ts')).toBe(false);
  });

  it('points the entry point at the built Astro Worker and serves its assets', () => {
    const config = generatedFile(nodes, 'cloudflare.config.ts');

    expect(config).toContain("entrypoint: './dist/_worker.js'");
    expect(config).toContain('assets: {');
  });

  it('builds before deploying', () => {
    const manifest = JSON.parse(generatedFile(nodes, 'package.json')) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(manifest.dependencies.astro).toBeDefined();
    expect(manifest.scripts.dev).toBe('astro dev');
    expect(manifest.scripts['deploy:cf']).toContain('build');
  });
});

describe('a diagram of services with no Worker drawn', () => {
  const nodes = [
    { label: 'Session Store', typeId: 'kv' },
    { label: 'Uploads', typeId: 'r2' }
  ];

  // Somebody who drew only storage still meant to build something that uses it, so the plain
  // Worker is the right default rather than refusing the export.
  it('still generates a project, defaulting to the plain Worker', () => {
    expect(generatedFile(nodes, 'src/index.ts')).toContain('Hello from Cloudflare Workers!');
  });

  it('configures every service that was drawn', () => {
    const config = generatedFile(nodes, 'cloudflare.config.ts');

    expect(config).toContain('SESSION_STORE: bindings.kv(');
    expect(config).toContain('UPLOADS: bindings.r2(');
  });
});

describe('every catalogue binding kind', () => {
  it.each([
    ['Workers AI', 'workers-ai', 'WORKERS_AI: bindings.ai()'],
    ['a queue', 'queues', "TASK: bindings.queue({ name: 'task' })"],
    ['a Durable Object', 'durable-object', 'TASK: bindings.durableObject('],
    ['a Vectorize index', 'vectorize', "TASK: bindings.vectorize({ name: 'task' })"],
    ['Hyperdrive', 'hyperdrive', 'TASK: bindings.hyperdrive('],
    ['an Analytics Engine dataset', 'analytics-engine', 'TASK: bindings.analyticsEngineDataset('],
    ['browser rendering', 'browser-rendering', 'TASK: bindings.browser()'],
    ['a dispatch namespace', 'workers-for-platforms', 'TASK: bindings.dispatchNamespace(']
  ])('configures %s', (_description, typeId, expected) => {
    const label = typeId === 'workers-ai' ? 'Workers AI' : 'Task';
    const config = generatedFile(
      [
        { label: 'Worker', typeId: 'worker' },
        { label, typeId }
      ],
      'cloudflare.config.ts'
    );

    expect(config).toContain(expected);
  });

  it('configures several databases separately, naming the first for the migration script', () => {
    const files = generateScaffold(
      makeInput({
        nodes: [
          { label: 'Worker', typeId: 'worker' },
          { label: 'Users DB', typeId: 'd1' },
          { label: 'Analytics DB', typeId: 'd1' }
        ]
      }),
      FIXED_NOW
    );
    const config = files.get('cloudflare.config.ts') as string;
    const manifest = JSON.parse(files.get('package.json') as string) as {
      scripts: Record<string, string>;
    };

    expect(config).toContain('USERS_DB: bindings.d1(');
    expect(config).toContain('ANALYTICS_DB: bindings.d1(');
    expect(manifest.scripts['deploy:db']).toContain('USERS_DB');
  });
});

describe('a catalogue product this generator has not been taught yet', () => {
  // The catalogue's binding field is a plain string rather than a closed union, so a product
  // added there before this generator learns to configure it is possible. The right answer is a
  // project that still builds with the binding visibly absent, not one with invalid
  // configuration in it.
  it('omits the binding rather than emitting something invalid', () => {
    NODE_TYPE_MAP.set('test-only-future-binding', {
      category: 'compute',
      defaultHandles: [],
      description: '',
      icon: { kind: 'feather', name: 'Box' },
      label: 'Future Product',
      typeId: 'test-only-future-binding',
      wranglerBinding: 'future-binding-type'
    });

    try {
      const config = generatedFile(
        [
          { label: 'Worker', typeId: 'worker' },
          { label: 'Future Product', typeId: 'test-only-future-binding' }
        ],
        'cloudflare.config.ts'
      );

      expect(config).not.toContain('future-binding-type');
      expect(config).not.toContain('FUTURE_PRODUCT');
      expect(config).toContain('defineWorker({');
    } finally {
      NODE_TYPE_MAP.delete('test-only-future-binding');
    }
  });
});

describe('the generated README', () => {
  it('names the project', () => {
    expect(generatedFile([{ label: 'Worker', typeId: 'worker' }], 'README.md', 'My App')).toContain(
      'my-app'
    );
  });

  it('documents the database workflow when the diagram has one', () => {
    const readme = generatedFile(
      [
        { label: 'Worker', typeId: 'worker' },
        { label: 'Main Database', typeId: 'd1' }
      ],
      'README.md'
    );

    expect(readme).toContain('Drizzle ORM');
    expect(readme).toContain('db:migrate:local');
  });

  it('omits the database workflow when the diagram has none', () => {
    const readme = generatedFile([{ label: 'Worker', typeId: 'worker' }], 'README.md');

    expect(readme).not.toContain('Drizzle ORM');
    expect(readme).not.toContain('deploy:db');
  });

  // The template carries both branches bracketed by markers, so a marker reaching the downloaded
  // file is the signature of a branch that was neither kept nor removed properly.
  it.each([
    ['with a database', true],
    ['without a database', false]
  ])('leaves no template marker in the file %s', (_description, withD1) => {
    const nodes = withD1
      ? [
          { label: 'Worker', typeId: 'worker' },
          { label: 'Main Database', typeId: 'd1' }
        ]
      : [{ label: 'Worker', typeId: 'worker' }];

    expect(generatedFile(nodes, 'README.md')).not.toMatch(/\{\{[A-Z_]+\}\}/u);
  });
});
