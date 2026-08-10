/**
 * Standalone Cloudflare project scaffold generator.
 *
 * Walks a diagram graph and produces a `Map<filePath, fileContent>` for a downloadable, ordinary
 * (non-Terraform, non-`cloudflare-toolkit`) `wrangler.toml`-based starter project — the generated
 * project is a teaching artifact for whoever downloads it, not code this demo itself runs, so it
 * deliberately does not follow this repository's own Terraform/Wrangler-template/raw-D1
 * conventions (docs/09-ARCHITECT.md's Phase 5 "Port" disposition for this feature). The caller
 * (`../components/editor/toolbar/ExportButton.tsx`) zips the returned map with `fflate` and
 * triggers the browser download.
 *
 * Ported directly from CF-Architect's `src/lib/scaffold.ts`, unchanged in logic — only the
 * `NODE_TYPE_MAP` import path and the raw-text template imports moved to match this host app's
 * layout.
 */

import { NODE_TYPE_MAP } from "../../catalog";

import astroConfig from "./scaffold-templates/astro/astro.config.mjs?raw";
import astroIndex from "./scaffold-templates/astro/src/pages/index.astro?raw";
import drizzleConfig from "./scaffold-templates/drizzle/drizzle.config.ts?raw";
import drizzleClient from "./scaffold-templates/drizzle/src/db/client.ts?raw";
import drizzleSchema from "./scaffold-templates/drizzle/src/db/schema.ts?raw";
import honoIndex from "./scaffold-templates/hono/src/index.ts?raw";
import migrationStub from "./scaffold-templates/migrations/0001_initial.sql?raw";
import readmeTemplate from "./scaffold-templates/README.md.tmpl?raw";
import baseTsconfig from "./scaffold-templates/tsconfig.json?raw";
import vanillaIndex from "./scaffold-templates/vanilla/src/index.ts?raw";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal node shape the scaffold generator needs from the canvas. */
interface ScaffoldNode {
  typeId: string;
  label: string;
}

/** Minimal edge shape the scaffold generator needs from the canvas. */
interface ScaffoldEdge {
  source: string;
  target: string;
  edgeType?: string;
}

/** Input to {@link generateScaffold}. */
export interface ScaffoldInput {
  title: string;
  nodes: ScaffoldNode[];
  edges: ScaffoldEdge[];
}

/** A catalog binding resolved to concrete, per-diagram names. */
interface ResolvedBinding {
  /** `wrangler.toml` section key, e.g. `"d1_databases"`. */
  wranglerBinding: string;
  /** SCREAMING_SNAKE_CASE binding name. */
  bindingName: string;
  /** Human label from the diagram. */
  label: string;
  /** Lowercase resource name for `wrangler.toml` resource-name fields. */
  resourceName: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a user label into SCREAMING_SNAKE_CASE suitable for a binding name.
 *
 * @example toBindingName("My D1 Database") // "MY_D1_DATABASE"
 */
export function toBindingName(label: string): string {
  return (
    label
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .toUpperCase() || "BINDING"
  );
}

/**
 * Convert a label into a lowercase-kebab resource name.
 *
 * @example toResourceName("My D1 Database") // "my-d1-database"
 */
export function toResourceName(label: string): string {
  return (
    label
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase() || "resource"
  );
}

/** Sanitize a title into a valid npm package / wrangler project name. */
export function toProjectName(title: string): string {
  return (
    title
      .replace(/[^a-zA-Z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase() || "my-cloudflare-project"
  );
}

// ---------------------------------------------------------------------------
// Binding section generators for wrangler.toml
// ---------------------------------------------------------------------------

/** A function that renders one `wrangler.toml` section for every resolved binding of its type. */
type SectionEmitter = (bindings: ResolvedBinding[]) => string;

/** One `wrangler.toml` section emitter per catalog `wranglerBinding` value. */
const sectionEmitters: Record<string, SectionEmitter> = {
  ai: () => `[ai]\nbinding = "AI"`,

  analytics_engine_datasets: (bindings) =>
    bindings
      .map((b) => `[[analytics_engine_datasets]]\nbinding = "${b.bindingName}"`)
      .join("\n\n"),

  browser: () => `[browser]\nbinding = "BROWSER"`,

  d1_databases: (bindings) =>
    bindings
      .map(
        (b) =>
          `[[d1_databases]]\nbinding = "${b.bindingName}"\ndatabase_name = "${b.resourceName}"\ndatabase_id = "<INSERT_DATABASE_ID>"\nmigrations_dir = "migrations"`,
      )
      .join("\n\n"),

  dispatch_namespaces: (bindings) =>
    bindings
      .map(
        (b) =>
          `[[dispatch_namespaces]]\nbinding = "${b.bindingName}"\nnamespace = "${b.resourceName}"`,
      )
      .join("\n\n"),

  durable_objects: (bindings) => {
    const classes = bindings
      .map(
        (b) =>
          `  { binding = "${b.bindingName}", class_name = "${b.bindingName}" }`,
      )
      .join(",\n");
    return `[durable_objects]\nbindings = [\n${classes}\n]`;
  },

  hyperdrive: (bindings) =>
    bindings
      .map(
        (b) =>
          `[[hyperdrive]]\nbinding = "${b.bindingName}"\nid = "<INSERT_HYPERDRIVE_ID>"`,
      )
      .join("\n\n"),

  kv_namespaces: (bindings) =>
    bindings
      .map(
        (b) =>
          `[[kv_namespaces]]\nbinding = "${b.bindingName}"\nid = "<INSERT_NAMESPACE_ID>"`,
      )
      .join("\n\n"),

  queues: (bindings) =>
    bindings
      .map(
        (b) =>
          `[[queues.producers]]\nbinding = "${b.bindingName}"\nqueue = "${b.resourceName}"`,
      )
      .join("\n\n"),

  r2_buckets: (bindings) =>
    bindings
      .map(
        (b) =>
          `[[r2_buckets]]\nbinding = "${b.bindingName}"\nbucket_name = "${b.resourceName}"`,
      )
      .join("\n\n"),

  vectorize: (bindings) =>
    bindings
      .map(
        (b) =>
          `[[vectorize]]\nbinding = "${b.bindingName}"\nindex_name = "${b.resourceName}"`,
      )
      .join("\n\n"),
};

// ---------------------------------------------------------------------------
// wrangler.toml generation
// ---------------------------------------------------------------------------

/**
 * Render the generated project's `wrangler.toml`: the base name/main/compatibility fields, an
 * Astro-specific `[assets]` block when `scaffoldTemplate` is `"astro"`, and one section per
 * resolved binding type via {@link sectionEmitters}.
 *
 * @param projectName Sanitized project name for the `name` field.
 * @param bindingsByType Resolved bindings grouped by their catalog `wranglerBinding` value.
 * @param scaffoldTemplate Catalog `scaffoldTemplate` value driving `main`/`[assets]`.
 * @returns The complete `wrangler.toml` file contents.
 */
function generateWranglerToml(
  projectName: string,
  bindingsByType: Map<string, ResolvedBinding[]>,
  scaffoldTemplate: string,
): string {
  const lines: string[] = [
    `name = "${projectName}"`,
    `main = "${scaffoldTemplate === "astro" ? "dist/_worker.js" : "src/index.ts"}"`,
    `compatibility_date = "${new Date().toISOString().slice(0, 10)}"`,
    `compatibility_flags = ["nodejs_compat"]`,
  ];

  if (scaffoldTemplate === "astro") {
    lines.push(`\n[assets]\ndirectory = "dist"`);
  }

  for (const [bindingType, bindings] of bindingsByType) {
    const emitter = sectionEmitters[bindingType];
    if (emitter) {
      lines.push("");
      lines.push(emitter(bindings));
    }
  }

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// package.json generation
// ---------------------------------------------------------------------------

/**
 * Render the generated project's `package.json`: base dependencies plus template-specific
 * dependencies (Hono, Astro), and D1-specific scripts (migration/deploy commands) when the
 * diagram has at least one D1 database node.
 *
 * @param projectName Sanitized project name for the `name` field.
 * @param scaffoldTemplate Catalog `scaffoldTemplate` value selecting which framework dependency
 * set to include.
 * @param hasD1 Whether the diagram has at least one D1 database node; adds Drizzle and D1
 * migration scripts when `true`.
 * @param d1Bindings Every resolved D1 binding, used only for `deploy:db`'s target binding name
 * (the first D1 database's).
 * @returns The complete `package.json` file contents, pretty-printed.
 */
function generatePackageJson(
  projectName: string,
  scaffoldTemplate: string,
  hasD1: boolean,
  d1Bindings: ResolvedBinding[],
): string {
  const deps: Record<string, string> = {};
  const devDeps: Record<string, string> = {
    "@cloudflare/workers-types": "^5.0.0",
    "npm-run-all": "^4.1.5",
    typescript: "^5.7.0",
    wrangler: "^4.0.0",
  };

  if (scaffoldTemplate === "hono") {
    deps.hono = "^4.0.0";
  } else if (scaffoldTemplate === "astro") {
    deps.astro = "^7.0.0";
    deps["@astrojs/cloudflare"] = "^14.0.0";
  }

  if (hasD1) {
    deps["drizzle-orm"] = "^0.45.0";
    devDeps["drizzle-kit"] = "^0.31.0";
  }

  const scripts: Record<string, string> = {};

  if (scaffoldTemplate === "astro") {
    scripts.dev = "astro dev";
    scripts.build = "astro build";
    scripts["deploy:cf"] = "npm run build && wrangler deploy";
  } else {
    scripts.dev = "wrangler dev";
    scripts["deploy:cf"] = "wrangler deploy";
  }

  if (hasD1) {
    // `hasD1` is only true when `bindingsByType.get("d1_databases")` is a non-empty array (it
    // is only ever populated via a `.push()` immediately followed by `.set()` above), so its
    // first element is always present here.
    const firstD1 = d1Bindings[0].bindingName;
    scripts["deploy:db"] = `wrangler d1 migrations apply ${firstD1} --remote`;
    scripts.deploy = "run-s deploy:db deploy:cf";
    scripts["db:generate"] = "drizzle-kit generate";
    scripts["db:migrate:local"] =
      `wrangler d1 migrations apply ${firstD1} --local`;
  } else {
    scripts.deploy = "run-s deploy:cf";
  }

  const pkg = {
    dependencies: Object.keys(deps).length > 0 ? deps : undefined,
    devDependencies: devDeps,
    name: projectName,
    private: true,
    scripts,
    type: "module",
    version: "0.1.0",
  };

  return `${JSON.stringify(pkg, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// README generation
// ---------------------------------------------------------------------------

/**
 * Render the generated project's `README.md` from `scaffold-templates/README.md.tmpl` by
 * substituting `{{PROJECT_NAME}}` and stripping whichever of the template's D1/no-D1 marker
 * sections don't apply, keeping the surviving section's own start/end markers themselves
 * stripped too so no literal `{{...}}` marker ever reaches the downloaded file.
 *
 * @param projectName Sanitized project name substituted into the template.
 * @param hasD1 Whether the diagram has at least one D1 database node; selects which marked
 * sections survive.
 * @returns The complete `README.md` file contents.
 */
function generateReadme(projectName: string, hasD1: boolean): string {
  let readme = readmeTemplate
    .replace(/\r\n/g, "\n")
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName);

  if (hasD1) {
    readme = readme
      .replace(/\{\{D1_LOCAL_SECTION\}\}\n/g, "")
      .replace(/\{\{D1_LOCAL_SECTION_START\}\}\n/g, "")
      .replace(/\{\{D1_LOCAL_SECTION_END\}\}\n/g, "")
      .replace(/\{\{D1_DEPLOY_SECTION_START\}\}\n/g, "")
      .replace(/\{\{D1_DEPLOY_SECTION_END\}\}\n/g, "")
      .replace(
        /\{\{NO_D1_DEPLOY_SECTION_START\}\}[\s\S]*?\{\{NO_D1_DEPLOY_SECTION_END\}\}\n/g,
        "",
      )
      .replace(/\{\{D1_LINKS_START\}\}\n/g, "")
      .replace(/\{\{D1_LINKS_END\}\}\n/g, "");
  } else {
    readme = readme
      .replace(/\{\{D1_LOCAL_SECTION\}\}\n/g, "")
      .replace(
        /\{\{D1_LOCAL_SECTION_START\}\}[\s\S]*?\{\{D1_LOCAL_SECTION_END\}\}\n/g,
        "",
      )
      .replace(
        /\{\{D1_DEPLOY_SECTION_START\}\}[\s\S]*?\{\{D1_DEPLOY_SECTION_END\}\}\n/g,
        "",
      )
      .replace(/\{\{NO_D1_DEPLOY_SECTION_START\}\}\n/g, "")
      .replace(/\{\{NO_D1_DEPLOY_SECTION_END\}\}\n/g, "")
      .replace(/\{\{D1_LINKS_START\}\}[\s\S]*?\{\{D1_LINKS_END\}\}\n/g, "");
  }

  return readme;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate a complete project scaffold from a diagram's nodes and edges.
 *
 * Every node with a catalog `wranglerBinding` (docs/09-ARCHITECT.md's Data Model note on
 * `src/catalog.ts`) contributes a `wrangler.toml` binding section, keyed by the node's
 * user-editable label; a node whose catalog type sets `scaffoldTemplate` (one of the three
 * Workers node types: plain, Hono, or Astro SSR) selects the generated `src/index.ts`'s
 * framework. Every unrecognized node (no matching catalog entry, or a catalog entry with neither
 * `wranglerBinding` nor `scaffoldTemplate` — an external actor, for example) contributes nothing.
 *
 * @returns A `Map` of file paths to file contents, ready to zip. Empty when the diagram has no
 * Worker node and no bindable services at all, so the caller can show a disabled export state
 * rather than downloading an empty project.
 */
export function generateScaffold(input: ScaffoldInput): Map<string, string> {
  const files = new Map<string, string>();
  const projectName = toProjectName(input.title);

  const bindingsByType = new Map<string, ResolvedBinding[]>();
  let scaffoldTemplate = "vanilla";
  let hasWorker = false;

  for (const node of input.nodes) {
    const def = NODE_TYPE_MAP.get(node.typeId);
    if (!def) continue;

    if (def.scaffoldTemplate) {
      scaffoldTemplate = def.scaffoldTemplate;
    }

    if (def.wranglerBinding === "worker") {
      hasWorker = true;
      continue;
    }

    if (!def.wranglerBinding) continue;

    const binding: ResolvedBinding = {
      bindingName: toBindingName(node.label),
      label: node.label,
      resourceName: toResourceName(node.label),
      wranglerBinding: def.wranglerBinding,
    };

    const existing = bindingsByType.get(def.wranglerBinding) ?? [];
    existing.push(binding);
    bindingsByType.set(def.wranglerBinding, existing);
  }

  const hasBindings = bindingsByType.size > 0;
  if (!hasWorker && !hasBindings) {
    return files;
  }

  const hasD1 = bindingsByType.has("d1_databases");
  const d1Bindings = bindingsByType.get("d1_databases") ?? [];

  files.set(
    "wrangler.toml",
    generateWranglerToml(projectName, bindingsByType, scaffoldTemplate),
  );

  files.set(
    "package.json",
    generatePackageJson(projectName, scaffoldTemplate, hasD1, d1Bindings),
  );

  files.set("tsconfig.json", baseTsconfig);

  switch (scaffoldTemplate) {
    case "hono":
      files.set("src/index.ts", honoIndex);
      break;
    case "astro":
      files.set("astro.config.mjs", astroConfig);
      files.set("src/pages/index.astro", astroIndex);
      break;
    default:
      files.set("src/index.ts", vanillaIndex);
      break;
  }

  if (hasD1) {
    files.set("drizzle.config.ts", drizzleConfig);
    files.set("src/db/schema.ts", drizzleSchema);
    files.set("src/db/client.ts", drizzleClient);
    files.set("migrations/0001_initial.sql", migrationStub);
  }

  files.set("README.md", generateReadme(projectName, hasD1));

  return files;
}
