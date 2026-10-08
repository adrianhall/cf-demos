import { NODE_TYPE_MAP } from '../../catalog.ts';
import astroConfig from './scaffold-templates/astro/astro.config.mjs?raw';
import astroIndex from './scaffold-templates/astro/src/pages/index.astro?raw';
import drizzleConfig from './scaffold-templates/drizzle/drizzle.config.ts?raw';
import drizzleClient from './scaffold-templates/drizzle/src/db/client.ts?raw';
import drizzleSchema from './scaffold-templates/drizzle/src/db/schema.ts?raw';
import honoIndex from './scaffold-templates/hono/src/index.ts?raw';
import migrationStub from './scaffold-templates/migrations/0001_initial.sql?raw';
import readmeTemplate from './scaffold-templates/README.md.tmpl?raw';
import baseTsconfig from './scaffold-templates/tsconfig.json?raw';
import vanillaIndex from './scaffold-templates/vanilla/src/index.ts?raw';

/**
 * @file Turns a diagram into a downloadable starter project — a `Map` of file path to file content,
 *   which the export control zips in the browser. **Pure, and deliberately DOM-free.** Nothing here
 *   touches `document`, a canvas, or React Flow's runtime: it reads a plain list of nodes and
 *   edges. That is what lets the same generator be reached by the MCP tool layer, where there is no
 *   browser at all; its sibling domain transform now does the same for a graph-derived SVG, while
 *   PNG and a pixel-faithful canvas capture still cannot. **What it generates is `cf`-native, which
 *   is a deliberate departure from the source.** The application this is ported from emitted a
 *   Wrangler project: a `wrangler.toml` and `wrangler deploy` scripts. This demo exists to teach
 *   the `cf` control plane that supersedes Wrangler, and handing a reader a starter project built
 *   on the superseded tool would teach the opposite of the surrounding demo. The generated project
 *   therefore declares its bindings in a typed `cloudflare.config.ts` through
 *   `defineConfig()`/`defineWorker()`, exactly as this demo's own configuration does. The deviation
 *   is recorded in the demo README. The generated project is a teaching artifact for whoever
 *   downloads it, not code this demo runs. It is an ordinary single-Worker starter rather than a
 *   copy of this repository's own Terraform-owned lifecycle, because somebody exporting a diagram
 *   wants a project they can `npm install` and deploy, not an infrastructure-as-code pipeline.
 */

/**
 * The fields the generator needs from a canvas node.
 *
 * Narrower than React Flow's own `Node` on purpose: a generator that accepted the whole node could
 * come to depend on its position or selection state, neither of which belongs in a generated
 * project.
 */
interface ScaffoldNode {
  /**
   * Catalogue type identifier, resolved through `NODE_TYPE_MAP`.
   */
  typeId: string;
  /**
   * The node's user-editable label, which becomes its binding and resource name.
   */
  label: string;
}

/**
 * The fields the generator needs from a canvas edge.
 */
interface ScaffoldEdge {
  /**
   * Id of the node the edge leaves.
   */
  source: string;
  /**
   * Id of the node the edge reaches.
   */
  target: string;
  /**
   * Catalogue edge type, if the edge carries one.
   */
  edgeType?: string;
}

/**
 * Input to {@link generateScaffold}.
 */
export interface ScaffoldInput {
  /**
   * Diagram title, sanitised into the generated project's name.
   */
  title: string;
  /**
   * Nodes on the canvas.
   */
  nodes: ScaffoldNode[];
  /**
   * Edges on the canvas.
   *
   * Accepted but not yet read. Edges describe how the services talk to each other, which a
   * generated project cannot express as configuration — a service binding is the one exception, and
   * this demo's catalogue has no second Worker to bind to. Taking them now keeps the signature
   * stable for a later phase rather than changing it then.
   */
  edges: ScaffoldEdge[];
}

/**
 * A catalogue binding resolved to one diagram node's concrete names.
 */
interface ResolvedBinding {
  /**
   * The catalogue's binding-kind key, for example `d1_databases`.
   */
  wranglerBinding: string;
  /**
   * SCREAMING_SNAKE_CASE name the binding appears under on `env`.
   */
  bindingName: string;
  /**
   * The node's label, as the visitor wrote it.
   */
  label: string;
  /**
   * Lowercase-kebab resource name, used where Cloudflare names the resource itself.
   */
  resourceName: string;
}

/**
 * Converts a label into a SCREAMING_SNAKE_CASE binding name.
 *
 * A binding name becomes a property on `env` and must be a valid identifier, so everything outside
 * letters, digits and spaces is dropped rather than replaced — an underscore per stray character
 * would turn `user-data (prod)` into something unreadable.
 *
 * @param label Node label, as the visitor wrote it.
 * @returns The binding name, falling back to `BINDING` when the label has no usable characters.
 */
export function toBindingName(label: string): string {
  return (
    label
      .replace(/[^a-zA-Z0-9\s]/gu, '')
      .trim()
      .replace(/\s+/gu, '_')
      .toUpperCase() || 'BINDING'
  );
}

/**
 * Converts a label into a lowercase-kebab resource name.
 *
 * Used where Cloudflare names the resource rather than the binding — a D1 database name, a queue,
 * an R2 bucket — all of which accept this shape.
 *
 * @param label Node label, as the visitor wrote it.
 * @returns The resource name, falling back to `resource` when the label has no usable
 * characters.
 */
export function toResourceName(label: string): string {
  return (
    label
      .replace(/[^a-zA-Z0-9\s]/gu, '')
      .trim()
      .replace(/\s+/gu, '-')
      .toLowerCase() || 'resource'
  );
}

/**
 * Converts a diagram title into a project and Worker name.
 *
 * Hyphens survive here where {@link toResourceName} would have produced them anyway, because a
 * visitor who titled a diagram `my-api` meant that name rather than `my-api` spelled differently.
 *
 * @param title Diagram title.
 * @returns The project name, falling back to `my-cloudflare-project` when the title has no usable
 *   characters.
 */
export function toProjectName(title: string): string {
  return (
    title
      .replace(/[^a-zA-Z0-9\s-]/gu, '')
      .trim()
      .replace(/\s+/gu, '-')
      .toLowerCase() || 'my-cloudflare-project'
  );
}

/**
 * Renders one `bindings.*` expression for a resolved binding.
 */
type BindingEmitter = (binding: ResolvedBinding) => string;

/**
 * One `cf/config` binding expression per catalogue binding kind.
 *
 * Keyed by the catalogue's own `wranglerBinding` value, which is the stable identifier the
 * catalogue already carries. A kind with no entry here emits nothing at all, which is the right
 * answer for a catalogue product added before this generator learns to configure it: the project
 * still builds, and the missing binding is visible as an absence rather than as invalid
 * configuration.
 *
 * Placeholders are written as `<INSERT_...>` strings wherever the value is an id Cloudflare issues
 * when the resource is created. They are deliberately not valid: a generated project must fail
 * loudly on first deploy rather than silently bind to nothing.
 */
const bindingEmitters: Record<string, BindingEmitter> = {
  ai: () => 'bindings.ai()',

  analytics_engine_datasets: (binding) =>
    `bindings.analyticsEngineDataset({ name: '${binding.resourceName}' })`,

  browser: () => 'bindings.browser()',

  d1: (binding) => `bindings.d1({ id: '<INSERT_DATABASE_ID>', name: '${binding.resourceName}' })`,

  dispatch_namespaces: (binding) =>
    `bindings.dispatchNamespace({ namespace: '${binding.resourceName}' })`,

  // The class has to exist in this Worker's own entry point before the binding resolves, so the
  // generated project points at itself by name and leaves the class as the reader's next step.
  durable_objects: (binding) =>
    `bindings.durableObject({ worker: PROJECT_NAME, exportName: '${binding.bindingName}' })`,

  hyperdrive: () => `bindings.hyperdrive({ id: '<INSERT_HYPERDRIVE_ID>' })`,

  kv: () => `bindings.kv({ id: '<INSERT_NAMESPACE_ID>' })`,

  queues: (binding) => `bindings.queue({ name: '${binding.resourceName}' })`,

  r2_buckets: (binding) => `bindings.r2({ name: '${binding.resourceName}' })`,

  vectorize: (binding) => `bindings.vectorize({ name: '${binding.resourceName}' })`
};

/**
 * Maps a catalogue binding kind to the key {@link bindingEmitters} uses.
 *
 * The catalogue's `wranglerBinding` values are Wrangler section names, two of which are plural
 * where this generator's key is not. Translating here rather than editing the catalogue keeps that
 * shared module byte-identical to the source it was ported from.
 */
const EMITTER_KEYS: Record<string, string> = {
  d1_databases: 'd1',
  kv_namespaces: 'kv'
};

/**
 * Renders the generated project's `cloudflare.config.ts`.
 *
 * The compatibility date is today's, which is the correct default for a project being created now:
 * it pins the runtime behaviour the generated code was written against, and the reader advances it
 * deliberately later.
 *
 * @param projectName Sanitised project and Worker name.
 * @param bindings Every resolved binding, in the order its node appeared on the canvas.
 * @param scaffoldTemplate Catalogue template driving the entry point and the assets block.
 * @param now Clock reading for the compatibility date. Injected so a test asserts a fixed value
 *   rather than racing midnight; defaults to the current time.
 * @returns The complete file contents.
 */
function generateCloudflareConfig(
  projectName: string,
  bindings: ResolvedBinding[],
  scaffoldTemplate: string,
  now: Date
): string {
  const entries = bindings
    .map((binding) => {
      const emit =
        bindingEmitters[EMITTER_KEYS[binding.wranglerBinding] ?? binding.wranglerBinding];
      return emit === undefined
        ? null
        : `      // ${binding.label}\n      ${binding.bindingName}: ${emit(binding)}`;
    })
    .filter((entry): entry is string => entry !== null);

  const entrypoint = scaffoldTemplate === 'astro' ? './dist/_worker.js' : './src/index.ts';
  const assets =
    scaffoldTemplate === 'astro'
      ? "\n\n    assets: {\n      notFoundHandling: 'single-page-application'\n    },"
      : '';

  return `import { bindings, defineConfig, defineWorker } from 'cf/config';

/**
 * Typed configuration for this Worker, generated by Architect from your diagram.
 *
 * Every service you drew on the canvas appears as a binding below and reaches your code on
 * \`env\`. Run \`npm run types\` after changing anything here to regenerate the \`Env\` type.
 */
const PROJECT_NAME = '${projectName}';

export default defineConfig({
  worker: defineWorker({
    name: PROJECT_NAME,
    entrypoint: '${entrypoint}',
    compatibilityDate: '${now.toISOString().slice(0, 10)}',
    compatibilityFlags: ['nodejs_compat'],${assets}

    env: {
${entries.join(',\n')}
    }
  })
});
`;
}

/**
 * Renders the generated project's `package.json`.
 *
 * @param projectName Sanitised project name.
 * @param scaffoldTemplate Catalogue template selecting the framework dependencies and commands.
 * @param d1Bindings Every resolved D1 binding. Empty when the diagram has no database, which is
 *   what selects the shorter script set.
 * @returns The complete file contents, pretty-printed.
 */
function generatePackageJson(
  projectName: string,
  scaffoldTemplate: string,
  d1Bindings: ResolvedBinding[]
): string {
  const hasD1 = d1Bindings.length > 0;

  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {
    '@cloudflare/workers-types': '^5.0.0',
    'cf': '^1.0.0-beta.12',
    'npm-run-all2': '^9.0.0',
    'typescript': '^5.7.0'
  };

  if (scaffoldTemplate === 'hono') {
    dependencies.hono = '^4.0.0';
  } else if (scaffoldTemplate === 'astro') {
    dependencies.astro = '^7.0.0';
    dependencies['@astrojs/cloudflare'] = '^14.0.0';
  }

  if (hasD1) {
    dependencies['drizzle-orm'] = '^0.45.0';
    devDependencies['drizzle-kit'] = '^0.31.0';
  }

  const scripts: Record<string, string> = {
    types: 'cf workers types --mode development'
  };

  if (scaffoldTemplate === 'astro') {
    scripts.dev = 'astro dev';
    scripts.build = 'astro build';
    scripts['deploy:cf'] = 'run-s build && cf deploy';
  } else {
    scripts.dev = 'cf dev';
    scripts['deploy:cf'] = 'cf deploy';
  }

  if (hasD1) {
    // The first D1 database on the canvas. A project with several still needs one named target
    // for the convenience script; the rest are migrated by repeating it with another binding.
    const firstD1 = (d1Bindings[0] as ResolvedBinding).bindingName;
    scripts['deploy:db'] = `cf d1 migrations apply ${firstD1} --remote`;
    // Database before code, so a deployed Worker never meets a schema it predates.
    scripts.deploy = 'run-s deploy:db deploy:cf';
    scripts['db:generate'] = 'drizzle-kit generate';
    scripts['db:migrate:local'] = `cf d1 migrations apply ${firstD1} --local`;
  } else {
    scripts.deploy = 'run-s deploy:cf';
  }

  const manifest = {
    name: projectName,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts,
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    devDependencies
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Renders the generated project's `README.md` from its template.
 *
 * The template carries both the D1 and the no-D1 prose, bracketed by markers. Whichever does not
 * apply is removed along with its markers, and the surviving section's markers are stripped too, so
 * no literal `{{...}}` ever reaches the downloaded file.
 *
 * @param projectName Sanitised project name, substituted for `{{PROJECT_NAME}}`.
 * @param hasD1 Whether the diagram has at least one D1 database.
 * @returns The complete file contents.
 */
function generateReadme(projectName: string, hasD1: boolean): string {
  const readme = readmeTemplate
    .replace(/\r\n/gu, '\n')
    .replace(/\{\{PROJECT_NAME\}\}/gu, projectName)
    .replace(/\{\{D1_LOCAL_SECTION\}\}\n/gu, '');

  if (hasD1) {
    return readme
      .replace(/\{\{D1_LOCAL_SECTION_START\}\}\n/gu, '')
      .replace(/\{\{D1_LOCAL_SECTION_END\}\}\n/gu, '')
      .replace(/\{\{D1_DEPLOY_SECTION_START\}\}\n/gu, '')
      .replace(/\{\{D1_DEPLOY_SECTION_END\}\}\n/gu, '')
      .replace(/\{\{NO_D1_DEPLOY_SECTION_START\}\}[\s\S]*?\{\{NO_D1_DEPLOY_SECTION_END\}\}\n/gu, '')
      .replace(/\{\{D1_LINKS_START\}\}\n/gu, '')
      .replace(/\{\{D1_LINKS_END\}\}\n/gu, '');
  }

  return readme
    .replace(/\{\{D1_LOCAL_SECTION_START\}\}[\s\S]*?\{\{D1_LOCAL_SECTION_END\}\}\n/gu, '')
    .replace(/\{\{D1_DEPLOY_SECTION_START\}\}[\s\S]*?\{\{D1_DEPLOY_SECTION_END\}\}\n/gu, '')
    .replace(/\{\{NO_D1_DEPLOY_SECTION_START\}\}\n/gu, '')
    .replace(/\{\{NO_D1_DEPLOY_SECTION_END\}\}\n/gu, '')
    .replace(/\{\{D1_LINKS_START\}\}[\s\S]*?\{\{D1_LINKS_END\}\}\n/gu, '');
}

/**
 * Generates a complete starter project from a diagram's nodes and edges.
 *
 * Every node whose catalogue entry names a binding kind contributes one binding, named from the
 * node's own label — so the generated configuration reads like the diagram rather than like a list
 * of products. A node whose catalogue entry names a `scaffoldTemplate` instead (the three Workers
 * types: plain, Hono and Astro) selects the entry point. A node that is neither — an external
 * actor, a browser — contributes nothing, which is correct: it is not something Cloudflare
 * provisions.
 *
 * @param input The diagram's title, nodes and edges.
 * @param now Clock reading for the generated compatibility date. Injected so a test asserts a fixed
 *   value; defaults to the current time.
 * @returns A `Map` of file path to file content, ready to zip. **Empty** when the diagram has
 *   neither a Worker nor a bindable service, so the caller can refuse the export rather than
 *   handing somebody a project with nothing in it.
 */
export function generateScaffold(
  input: ScaffoldInput,
  now: Date = new Date()
): Map<string, string> {
  const files = new Map<string, string>();
  const projectName = toProjectName(input.title);

  const resolved: ResolvedBinding[] = [];
  let scaffoldTemplate = 'vanilla';
  let hasWorker = false;

  for (const node of input.nodes) {
    const definition = NODE_TYPE_MAP.get(node.typeId);
    if (!definition) {
      continue;
    }

    if (definition.scaffoldTemplate) {
      scaffoldTemplate = definition.scaffoldTemplate;
    }

    // The Worker is the project rather than a binding in it, so it selects the entry point above
    // and contributes nothing to `env`.
    if (definition.wranglerBinding === 'worker') {
      hasWorker = true;
      continue;
    }

    if (!definition.wranglerBinding) {
      continue;
    }

    resolved.push({
      bindingName: toBindingName(node.label),
      label: node.label,
      resourceName: toResourceName(node.label),
      wranglerBinding: definition.wranglerBinding
    });
  }

  if (!hasWorker && resolved.length === 0) {
    return files;
  }

  const d1Bindings = resolved.filter((binding) => binding.wranglerBinding === 'd1_databases');
  const hasD1 = d1Bindings.length > 0;

  files.set(
    'cloudflare.config.ts',
    generateCloudflareConfig(projectName, resolved, scaffoldTemplate, now)
  );
  files.set('package.json', generatePackageJson(projectName, scaffoldTemplate, d1Bindings));
  files.set('tsconfig.json', baseTsconfig);

  switch (scaffoldTemplate) {
    case 'hono':
      files.set('src/index.ts', honoIndex);
      break;
    case 'astro':
      files.set('astro.config.mjs', astroConfig);
      files.set('src/pages/index.astro', astroIndex);
      break;
    default:
      files.set('src/index.ts', vanillaIndex);
      break;
  }

  if (hasD1) {
    files.set('drizzle.config.ts', drizzleConfig);
    files.set('src/db/schema.ts', drizzleSchema);
    files.set('src/db/client.ts', drizzleClient);
    files.set('migrations/0001_initial.sql', migrationStub);
  }

  files.set('README.md', generateReadme(projectName, hasD1));

  return files;
}
