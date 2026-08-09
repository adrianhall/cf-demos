import { describe, expect, it } from "vitest";
import {
  generateScaffold,
  type ScaffoldInput,
  toBindingName,
} from "./scaffold";

function makeInput(overrides: Partial<ScaffoldInput> = {}): ScaffoldInput {
  return {
    edges: overrides.edges ?? [],
    nodes: overrides.nodes ?? [],
    title: overrides.title ?? "Test Project",
  };
}

describe("toBindingName", () => {
  it("converts a normal label to SCREAMING_SNAKE_CASE", () => {
    expect(toBindingName("My D1 Database")).toBe("MY_D1_DATABASE");
  });

  it("strips special characters", () => {
    expect(toBindingName("user-data (prod)")).toBe("USERDATA_PROD");
  });

  it("collapses multiple spaces", () => {
    expect(toBindingName("  Hello   World  ")).toBe("HELLO_WORLD");
  });

  it("falls back to BINDING for empty/special-only labels", () => {
    expect(toBindingName("")).toBe("BINDING");
    expect(toBindingName("!!!")).toBe("BINDING");
  });
});

describe("generateScaffold — empty cases", () => {
  it("returns an empty map for an empty diagram", () => {
    expect(generateScaffold(makeInput()).size).toBe(0);
  });

  it("returns an empty map when only external/unbound nodes are present", () => {
    const files = generateScaffold(
      makeInput({
        nodes: [
          { label: "Some API", typeId: "external-api" },
          { label: "Browser", typeId: "client-browser" },
        ],
      }),
    );
    expect(files.size).toBe(0);
  });

  it("returns an empty map for a node with no matching catalog entry", () => {
    const files = generateScaffold(
      makeInput({ nodes: [{ label: "Mystery", typeId: "not-a-real-type" }] }),
    );
    expect(files.size).toBe(0);
  });
});

describe("generateScaffold — vanilla Worker", () => {
  const files = generateScaffold(
    makeInput({
      nodes: [{ label: "API Worker", typeId: "worker" }],
      title: "My Vanilla App",
    }),
  );

  it("generates wrangler.toml with the project name", () => {
    const toml = files.get("wrangler.toml") as string;
    expect(toml).toContain('name = "my-vanilla-app"');
    expect(toml).toContain('main = "src/index.ts"');
    expect(toml).toContain("compatibility_flags");
  });

  it("generates a vanilla src/index.ts", () => {
    const src = files.get("src/index.ts") as string;
    expect(src).toContain("async fetch(");
    expect(src).toContain("Hello from Cloudflare Workers!");
  });

  it("generates package.json with wrangler and deploy scripts", () => {
    const pkg = JSON.parse(files.get("package.json") as string);
    expect(pkg.name).toBe("my-vanilla-app");
    expect(pkg.scripts.dev).toBe("wrangler dev");
    expect(pkg.scripts["deploy:cf"]).toBe("wrangler deploy");
    expect(pkg.scripts.deploy).toBe("run-s deploy:cf");
    expect(pkg.devDependencies.wrangler).toBeDefined();
    expect(pkg.devDependencies["npm-run-all"]).toBeDefined();
  });

  it("generates tsconfig.json", () => {
    expect(files.has("tsconfig.json")).toBe(true);
  });

  it("generates README.md", () => {
    const readme = files.get("README.md") as string;
    expect(readme).toContain("my-vanilla-app");
    expect(readme).toContain("npm install");
    expect(readme).toContain("npm run deploy");
  });

  it("does not include Drizzle files", () => {
    expect(files.has("drizzle.config.ts")).toBe(false);
    expect(files.has("src/db/schema.ts")).toBe(false);
    expect(files.has("src/db/client.ts")).toBe(false);
    expect(files.has("migrations/0001_initial.sql")).toBe(false);
  });
});

describe("generateScaffold — Hono Worker + D1 + KV", () => {
  const files = generateScaffold(
    makeInput({
      nodes: [
        { label: "API", typeId: "worker-hono" },
        { label: "Main Database", typeId: "d1" },
        { label: "Cache Store", typeId: "kv" },
      ],
      title: "Hono API",
    }),
  );

  it("generates wrangler.toml with D1 and KV bindings", () => {
    const toml = files.get("wrangler.toml") as string;
    expect(toml).toContain("[[d1_databases]]");
    expect(toml).toContain('binding = "MAIN_DATABASE"');
    expect(toml).toContain('database_name = "main-database"');
    expect(toml).toContain("[[kv_namespaces]]");
    expect(toml).toContain('binding = "CACHE_STORE"');
  });

  it("generates Hono src/index.ts", () => {
    const src = files.get("src/index.ts") as string;
    expect(src).toContain("Hono");
    expect(src).toContain("Hello from Hono");
  });

  it("generates package.json with hono, drizzle, and D1 scripts", () => {
    const pkg = JSON.parse(files.get("package.json") as string);
    expect(pkg.dependencies.hono).toBeDefined();
    expect(pkg.dependencies["drizzle-orm"]).toBeDefined();
    expect(pkg.devDependencies["drizzle-kit"]).toBeDefined();
    expect(pkg.scripts["deploy:db"]).toContain("MAIN_DATABASE");
    expect(pkg.scripts.deploy).toBe("run-s deploy:db deploy:cf");
    expect(pkg.scripts["db:generate"]).toBe("drizzle-kit generate");
    expect(pkg.scripts["db:migrate:local"]).toContain("MAIN_DATABASE");
  });

  it("includes Drizzle config, schema, client, and migration stub", () => {
    expect(files.has("drizzle.config.ts")).toBe(true);
    expect(files.has("src/db/schema.ts")).toBe(true);
    expect(files.has("src/db/client.ts")).toBe(true);
    expect(files.get("migrations/0001_initial.sql") as string).toContain(
      "CREATE TABLE",
    );
  });

  it("README includes D1 sections", () => {
    const readme = files.get("README.md") as string;
    expect(readme).toContain("Drizzle ORM");
    expect(readme).toContain("db:migrate:local");
    expect(readme).toContain("deploy:db");
  });
});

describe("generateScaffold — Astro + R2", () => {
  const files = generateScaffold(
    makeInput({
      nodes: [
        { label: "Web App", typeId: "worker-astro" },
        { label: "Asset Bucket", typeId: "r2" },
      ],
      title: "My Astro Site",
    }),
  );

  it("generates Astro scaffold files instead of src/index.ts", () => {
    expect(files.has("astro.config.mjs")).toBe(true);
    expect(files.has("src/pages/index.astro")).toBe(true);
    expect(files.has("src/index.ts")).toBe(false);
  });

  it("generates wrangler.toml with an R2 binding and astro-specific config", () => {
    const toml = files.get("wrangler.toml") as string;
    expect(toml).toContain("[[r2_buckets]]");
    expect(toml).toContain('binding = "ASSET_BUCKET"');
    expect(toml).toContain("[assets]");
  });

  it("generates package.json with astro deps and the astro dev command", () => {
    const pkg = JSON.parse(files.get("package.json") as string);
    expect(pkg.dependencies.astro).toBeDefined();
    expect(pkg.dependencies["@astrojs/cloudflare"]).toBeDefined();
    expect(pkg.scripts.dev).toBe("astro dev");
    expect(pkg.scripts["deploy:cf"]).toBe("npm run build && wrangler deploy");
  });

  it("does not include Drizzle files", () => {
    expect(files.has("drizzle.config.ts")).toBe(false);
  });

  it("README omits D1 sections", () => {
    const readme = files.get("README.md") as string;
    expect(readme).not.toContain("Drizzle ORM");
    expect(readme).not.toContain("deploy:db");
  });
});

describe("generateScaffold — bindings without an explicit Worker node", () => {
  const files = generateScaffold(
    makeInput({
      nodes: [
        { label: "Session Store", typeId: "kv" },
        { label: "Uploads", typeId: "r2" },
      ],
      title: "Storage Only",
    }),
  );

  it("still generates a scaffold, defaulting to the vanilla Worker template", () => {
    expect(files.size).toBeGreaterThan(0);
    expect(files.get("src/index.ts") as string).toContain(
      "Hello from Cloudflare Workers!",
    );
  });

  it("includes KV and R2 bindings in wrangler.toml", () => {
    const toml = files.get("wrangler.toml") as string;
    expect(toml).toContain("[[kv_namespaces]]");
    expect(toml).toContain("[[r2_buckets]]");
  });
});

describe("generateScaffold — every remaining catalog binding type", () => {
  it("generates a [ai] binding for Workers AI", () => {
    const toml = generateScaffold(
      makeInput({
        nodes: [
          { label: "Worker", typeId: "worker" },
          { label: "Workers AI", typeId: "workers-ai" },
        ],
      }),
    ).get("wrangler.toml") as string;
    expect(toml).toContain("[ai]");
    expect(toml).toContain('binding = "AI"');
  });

  it("generates separate sections for multiple D1 databases, using the first for deploy:db", () => {
    const files = generateScaffold(
      makeInput({
        nodes: [
          { label: "Worker", typeId: "worker" },
          { label: "Users DB", typeId: "d1" },
          { label: "Analytics DB", typeId: "d1" },
        ],
      }),
    );
    const toml = files.get("wrangler.toml") as string;
    expect(toml).toContain('binding = "USERS_DB"');
    expect(toml).toContain('binding = "ANALYTICS_DB"');
    const pkg = JSON.parse(files.get("package.json") as string);
    expect(pkg.scripts["deploy:db"]).toContain("USERS_DB");
  });

  it("generates a queues.producers section", () => {
    const toml = generateScaffold(
      makeInput({
        nodes: [
          { label: "Worker", typeId: "worker" },
          { label: "Task Queue", typeId: "queues" },
        ],
      }),
    ).get("wrangler.toml") as string;
    expect(toml).toContain("[[queues.producers]]");
    expect(toml).toContain('binding = "TASK_QUEUE"');
    expect(toml).toContain('queue = "task-queue"');
  });

  it("generates a durable_objects section", () => {
    const toml = generateScaffold(
      makeInput({
        nodes: [
          { label: "Worker", typeId: "worker" },
          { label: "Chat Room", typeId: "durable-object" },
        ],
      }),
    ).get("wrangler.toml") as string;
    expect(toml).toContain("[durable_objects]");
    expect(toml).toContain('binding = "CHAT_ROOM"');
    expect(toml).toContain('class_name = "CHAT_ROOM"');
  });

  it("generates a vectorize section", () => {
    const toml = generateScaffold(
      makeInput({
        nodes: [
          { label: "Worker", typeId: "worker" },
          { label: "Embeddings Index", typeId: "vectorize" },
        ],
      }),
    ).get("wrangler.toml") as string;
    expect(toml).toContain("[[vectorize]]");
    expect(toml).toContain('binding = "EMBEDDINGS_INDEX"');
    expect(toml).toContain('index_name = "embeddings-index"');
  });

  it("generates a hyperdrive section", () => {
    const toml = generateScaffold(
      makeInput({
        nodes: [
          { label: "Worker", typeId: "worker" },
          { label: "Postgres Cache", typeId: "hyperdrive" },
        ],
      }),
    ).get("wrangler.toml") as string;
    expect(toml).toContain("[[hyperdrive]]");
    expect(toml).toContain('binding = "POSTGRES_CACHE"');
    expect(toml).toContain("<INSERT_HYPERDRIVE_ID>");
  });

  it("generates an analytics_engine_datasets section", () => {
    const toml = generateScaffold(
      makeInput({
        nodes: [
          { label: "Worker", typeId: "worker" },
          { label: "Page Views", typeId: "analytics-engine" },
        ],
      }),
    ).get("wrangler.toml") as string;
    expect(toml).toContain("[[analytics_engine_datasets]]");
    expect(toml).toContain('binding = "PAGE_VIEWS"');
  });

  it("generates a browser section", () => {
    const toml = generateScaffold(
      makeInput({
        nodes: [
          { label: "Worker", typeId: "worker" },
          { label: "Renderer", typeId: "browser-rendering" },
        ],
      }),
    ).get("wrangler.toml") as string;
    expect(toml).toContain("[browser]");
    expect(toml).toContain('binding = "BROWSER"');
  });

  it("generates a dispatch_namespaces section", () => {
    const toml = generateScaffold(
      makeInput({
        nodes: [
          { label: "Worker", typeId: "worker" },
          { label: "Tenant Runtime", typeId: "workers-for-platforms" },
        ],
      }),
    ).get("wrangler.toml") as string;
    expect(toml).toContain("[[dispatch_namespaces]]");
    expect(toml).toContain('binding = "TENANT_RUNTIME"');
    expect(toml).toContain('namespace = "tenant-runtime"');
  });

  it("generates a hyperdrive id placeholder alongside a kv_namespaces id placeholder", () => {
    const toml = generateScaffold(
      makeInput({
        nodes: [
          { label: "Worker", typeId: "worker" },
          { label: "Session Cache", typeId: "kv" },
        ],
      }),
    ).get("wrangler.toml") as string;
    expect(toml).toContain("<INSERT_NAMESPACE_ID>");
  });
});
