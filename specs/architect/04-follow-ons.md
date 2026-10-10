# Follow-ons

## 1. Derive a safe default position for MCP-created nodes

### 1.1 Observation

`add_node` requires its MCP caller to supply an explicit canvas position. The tool now explains
that a caller must put a node next to the nodes it will connect to and re-tier the diagram with
`auto_layout_diagram` afterwards, but that still asks an agent to reason about a visual property
from raw graph coordinates. In the API Gateway blueprint, adding an Orders D1 database at the open
storage-row position to the right of the existing D1 database avoided node overlap but made the new
Gateway-to-Orders edge pass behind Data Service. The stored edge was correct; the picture was easy
to misread as Data Service-to-Orders.

### 1.2 Investigation notes

The pure domain function in
[`src/worker/domain/graph-mutations.ts`](../../cf-terraform-demos/architect/src/worker/domain/graph-mutations.ts)
stores precisely the `position` it receives. That is the correct current responsibility: it has no
knowledge of a future edge when `add_node` runs, and silently changing a caller-supplied coordinate
would make a successful tool call non-deterministic.

The MCP schema in
[`src/worker/mcp/server.ts`](../../cf-terraform-demos/architect/src/worker/mcp/server.ts) originally
only advised callers to leave enough space between nodes. It now also teaches edge readability and
names `auto_layout_diagram` as the follow-up after extending an existing graph. The server-side
auto-layout is intentionally a deterministic grid fallback, rather than the browser's ELK layout,
because the Phase 11 spike established that `elkjs` does not run in `workerd`.

A future change can consider making `position` optional and deriving a proposed location from the
existing graph and the new node's intended connections. That requires a design decision first:
either extend `add_node` to accept connection intent, add a higher-level compound mutation that
creates a node and its edges atomically, or return a proposed placement for the agent to confirm.
It must preserve the present explicit-position contract until that behaviour is specified and tested.

#### Additional findings

`autoLayout` in
[`src/worker/domain/graph-mutations.ts`](../../cf-terraform-demos/architect/src/worker/domain/graph-mutations.ts)
already contains most of the machinery a placement decision needs. It builds an adjacency list and
an in-degree count keyed by node index, assigns a row by breadth-first longest-path tiering from
the zero-in-degree roots, and tolerates a dangling edge by skipping it rather than throwing. A
placement function can reuse exactly that tiering to answer "which row does a node with these
connections belong in", without re-deriving the graph model.

The ordering problem is the real obstacle, and it is a sequencing problem rather than a geometry
one. `add_node` runs strictly before `add_edge`, so at the moment the position is chosen the graph
genuinely does not know what the node will connect to. No amount of cleverness inside `add_node`
recovers that information; it has to be supplied by the caller or deferred until the edges exist.

The observed defect is also specifically an *edge-routing* misreading, not an overlap. The Orders
node was placed in genuinely free space and the stored graph was correct; the picture misled because
the new edge's straight path crossed behind an unrelated node. That means node-overlap avoidance
alone would not have prevented it, and a placement rule has to consider the corridor an edge will
travel through, not just whether the destination cell is empty.

`src/blueprints.ts` is a useful oracle here: every blueprint carries hand-authored coordinates that
a human judged readable. They are a ready-made fixture set for asserting that a derived placement
agrees with human judgement on graphs whose correct answer is already known.

### 1.3 Plan

Adopt the **compound-mutation** option. It is the only one of the three that removes the root cause
rather than mitigating it: it makes the connections known at the instant the position is chosen,
which is precisely the information `add_node` lacks today. Extending `add_node` with "connection
intent" would encode the same information in a second, weaker form that could contradict the
`add_edge` calls that follow, and returning a proposal for confirmation adds a round trip while
still leaving an unconfirmed proposal to be handled.

Keep `add_node` exactly as it is. Its explicit-position contract stays the documented, deterministic
path, and no existing caller changes behaviour.

1. **Add a pure placement function to the domain tier.** In `graph-mutations.ts`, add
   `derivePosition(graph, connections)` returning a `{ x, y }`. Reuse the existing `autoLayout`
   tiering to place the node one row below its highest-tier source (or one row above its lowest-tier
   target when it has only targets), then choose the free column in that row that minimises edge
   crossings over unrelated nodes. Fall back to the first free cell in the row when every column is
   contested, and to `autoLayout`'s own origin when the graph is empty. It stays pure and
   synchronous, so it is unit-testable without a Durable Object.
2. **Make edge readability an explicit, tested property.** Add a helper that reports whether a
   straight segment between two points passes through any other node's bounding box, and assert in
   the unit tests that a derived placement produces no such crossing for the API Gateway blueprint's
   Orders-database case. This is the specific regression in the observation, so it gets a test that
   fails against today's behaviour.
3. **Add one new MCP tool, `add_connected_node`.** Parameters: `diagramId`, `typeId`, `label`,
   optional `id`/`description`, and `connectTo` — a list of `{ nodeId, direction }`, with `position`
   deliberately absent. It derives the position, creates the node, and creates every edge, applying
   the whole set through the existing operation vocabulary so it persists and broadcasts as one
   coherent change rather than a node followed by separately-observable edges.
4. **Steer callers toward it in the tool descriptions.** `add_node`'s description should name
   `add_connected_node` as the better choice when the node will be connected to something, which is
   the common case; `add_node` remains correct for a deliberately standalone node or an exact
   coordinate.
5. **Leave `auto_layout_diagram` unchanged.** It stays the "tidy the whole thing" escape hatch, and
   remains the deterministic grid fallback for the reason the investigation notes record.

Tests: unit coverage for `derivePosition` (empty graph, single source, several sources across tiers,
a full row, target-only connections) and for the crossing helper; an MCP-tool test proving
`add_connected_node` emits node and edge operations together; and a blueprint-derived case asserting
no edge crosses an unrelated node. Documentation: record the new tool in `MCP-VALIDATION.md` and the
demo `README.md`.

## 2. Provide a backup and restore capability

### 2.1 Observation

There is no mechanism to migrate from the old code to the new code without disrupting the database
and KV store contents.  This means user records, diagrams, and customer links will all be destroyed
when we upgrade.

### 2.2 Investigation notes

As we migrate from `cf-architect` to `architect`, we need to do a transition.  My preferred method
is to use a backup and restore.  We know the name of the D1 database and the KV store that are in 
use in `architect`.  We can use `cf` commands to export the contents of both, thus allowing the safe
transfer of both the current database and the shares.  We can then effect the change of code within
the worker (which will be handled manually), and finally, we restore the database and KV store so that
the data transitions correctly.  

This works because the database has not changed shape.

The preference is to provide two scripts:

- `node scripts/export.ts architect` will use the `architect` prefix, find the database and KV store, extract the data from them, dumping as a JSON file, or a series of files in a backup directory.
- `node scripts/import.ts architect` will use the `architect` prefix, find the database and KV store, and import the data exported with the export script to the new database.  It will fail if the database or KV store are not empty.

These scripts can also be used for routine maintenance (backup the database before uploading a new version, for example), so they are useful beyond this migration effort.

My process will be:

1. Run the export script and validate the output.
2. Remove the old `architect` worker, database, KV.
3. Update the terraform name from `cf-architect` to `architect` and deploy.
4. Run the import script and validate the database and KV store have been restored.

This is important because the terraform setup for the original version and the terraform setup for the new version are different, so we can't just tear down the original.

#### Additional findings

**There is no `cf d1 export` or `cf d1 import`.** `cf d1` offers only `create`, `delete`, `edit`,
`get`, `list`, `migrations`, `query`, `raw`, `time-travel` and `update`. The plan's assumption that
contents can be dumped with a single `cf` command does not hold, and the export has to be built from
`cf d1 query --sql`, reading each table and writing the rows as JSON. This is workable — the schema
is three small tables — but it means the scripts own the row-to-SQL round trip and must be tested
rather than trusted.

The building blocks that *do* exist are sufficient:

| Need                 | Command                                                           |
| -------------------- | ----------------------------------------------------------------- |
| Find the database    | `cf d1 list --name <prefix>-db`                                    |
| Read rows            | `cf d1 query <database-id> --sql "SELECT ..."`                     |
| Write rows           | `cf d1 query <database-id> --batch @file.json`                     |
| Find the namespace   | `cf kv namespaces list`                                            |
| Read keys            | `cf kv keys list --namespace-id <id> --limit --cursor` (paginated) |
| Read values          | `cf kv bulk get <namespace-id>`                                    |
| Write values         | `cf kv bulk put <namespace-id>` (10,000 pairs / 100 MB per call)   |

Resource names are derivable from the prefix, which is what makes a prefix argument viable:
`infra/providers.tf` sets `database_name = "${var.worker_name}-db"` and
`shares_kv_name = "${var.worker_name}-shares"`.

**The KV namespace does not need to be exported at all, and arguably should not be.**
`D1KvShareRepository.resolve` treats KV purely as a lookup cache in front of D1, and D1 is
authoritative for the share lifecycle: every KV hit is re-confirmed against an unrevoked
`diagram_shares` row, a miss is backfilled from D1, and a stale hit is deleted. An empty KV
namespace is therefore a cold cache that repairs itself on first use, not data loss. Restoring KV
also carries a genuine hazard the D1 restore does not: a key whose D1 row has since been revoked
would be reintroduced as a cache entry, and although `resolve` would refuse it, the restore would
have deliberately written back a digest for a dead bearer capability.

The export should still capture KV, because the stated purpose includes routine backup and a
forensic record of what was live is worth having. The *import* should skip it by default and offer
`--include-kv` for an operator who explicitly wants the warm cache. This should be stated in the
spec rather than left as an implementation detail, because it changes the operator's expectations
at step 4 of the cutover: a correct restore will leave the KV namespace empty.

**The non-empty guard needs care.** `diagram_shares` rows are never hard-deleted — revocation sets
`revoked_at` — so emptiness must be judged per table by `SELECT COUNT(*)`, not inferred from the
database existing. The guard must also run against every table before writing any of them, so a
partially-populated target is refused before the import has written half a dataset.

**Ordering and idempotency.** There are no foreign keys in the schema (a deliberate choice recorded
in `0001_create_diagrams_and_users.sql`), so table insert order does not matter for integrity.
Migrations must still have been applied before import, since the import writes rows and does not
create tables.

**Secrets.** `diagram_shares` stores only a SHA-256 digest and the KV values are digest → diagram-id
pairs, so no backup file contains a usable bearer token. This is worth asserting in a test so a
future schema change cannot quietly start writing raw tokens into a backup directory.

### 2.3 Plan

Two scripts in the repository-root `scripts/` directory, matching the existing
`scripts/d1-migrate.ts` conventions: `commander` for arguments, `cf` resolved from
`node_modules/cf/bin/cf`, full JSDoc, and failure messages that name the remediation.

**`node scripts/export.ts <prefix>`**

1. Resolve the database via `cf d1 list --name <prefix>-db` and the namespace via
   `cf kv namespaces list`, matching `<prefix>-shares`. Fail if either resolves to anything other
   than exactly one resource — an ambiguous prefix during a cutover, when both the old and new
   resources exist, is the single most dangerous condition these scripts can meet, and it must stop
   rather than guess.
2. Write a backup directory (default `backups/<prefix>-<ISO timestamp>/`) containing one JSON file
   per table (`diagrams.json`, `users.json`, `diagram_shares.json`, `diagram_collaborators.json`),
   one `shares-kv.json`, and a `manifest.json` recording the prefix, resolved resource ids and
   names, row counts, schema version (highest applied migration), and the export timestamp.
3. Page through `cf kv keys list` with `--cursor` until exhausted, then fetch values with
   `cf kv bulk get`. A single unpaged listing would silently truncate a large namespace, which is
   the worst possible failure in a backup tool.
4. Print a summary table of row counts so step 1 of the cutover process — "validate the output" —
   has something concrete to check.

**`node scripts/import.ts <prefix> --from <dir>`**

1. Resolve resources by the same rules, with the same ambiguity refusal.
2. Verify the manifest's schema version matches the target's applied migrations, and refuse on a
   mismatch. This is what makes "the database has not changed shape" a checked precondition rather
   than an assumption.
3. **Refuse unless every target table is empty**, counting all of them before writing any. Offer
   `--force` for a deliberate overwrite, defaulting to off.
4. Insert rows in batches via `cf d1 query --batch` with parameterised statements, never by
   string-concatenating values into SQL.
5. Skip KV unless `--include-kv` is passed, and say so in the output, for the self-healing-cache
   reason above.
6. Print the same summary table, so step 4's validation is a direct comparison against step 1's.

Both scripts take `--dry-run`, reporting exactly what they would read or write without doing it.

Tests: unit coverage for prefix → resource-name derivation, the ambiguity refusal, the non-empty
guard, cursor pagination assembling a complete key set, the schema-version check, batch chunking at
the 10,000-pair boundary, and an assertion that no exported field carries a raw share token. The
`cf` invocations are injected as a runner function so the tests stay offline, as the repository
requires.

Documentation: add a "Backup and restore" section to the demo `README.md` covering both routine
backup and the four-step cutover, stating explicitly that a correct restore leaves KV empty.

One sequencing note on the stated process: run the export **twice** — once to validate, and once
immediately before step 2 — so the restored data reflects the last moments before the old Worker was
removed rather than whatever was true when validation happened.

## 3. Product names are not current

### 3.1 Observation

The list of products in the sidebar are not consistent with current naming.  There are new products (such as K2), renames (such as Pipelines renamed to Basin Pipelines).  The cloudflare-docs are in ~/repos/cloudflare/cloudflare-docs for your review, and that repo contains the SVG icons for all products.   Task is to update the product list that is presented in the sidebar.

### 3.2 Investigation notes

The local checkout of `cloudflare/cloudflare-docs` is on `production` at `0017e51a28`
(2026-10-09), so it is current enough to be authoritative.

**There is a canonical product registry**, and it is better than reading page titles:
`src/content/directory/*.yaml`, one file per product, each carrying a `name`, an `entry.title`, an
`entry.url` and an `entry.group`. Filtering to `group: Developer platform` yields the 48 products
relevant to this catalogue. This is the list the docs site itself uses to resolve product names and
links, so matching it is matching Cloudflare's own source of truth rather than a transcription of
it.

**The renames are confirmed in the product documentation itself**, not inferred:

- `src/content/docs/basin/index.mdx`: "Basin was formerly known as Cloudflare Data Platform.
  Cloudflare Pipelines, R2 Data Catalog, and R2 SQL are now named Basin Pipelines, Basin Catalog,
  and Basin SQL. Existing resources and configurations continue to work."
- `src/content/docs/basin-pipelines/index.mdx`: "Basin Pipelines, formerly known as Cloudflare
  Pipelines, is now Generally Available."
- `src/content/docs/basin-sql/index.mdx`: "Basin SQL, formerly known as R2 SQL … Existing R2 SQL
  APIs continue to work and will be deprecated in the future."
- `src/content/docs/basin-catalog/index.mdx`: "Basin Catalog, formerly known as R2 Data Catalog, is
  now Generally Available."

So the three affected entries are `pipelines` → Basin Pipelines, `r2-sql` → Basin SQL, and
`r2-data-catalog` → Basin Catalog, with `basin` itself a new umbrella product. Each rename has a new
documentation URL (`/basin-pipelines/`, `/basin-sql/`, `/basin-catalog/`), so `docLinks` change too,
not just labels.

**The catalogue already has the right pattern for this.** The `autorag` and `browser-rendering`
entries were relabelled to "AI Search" and "Browser Run" while keeping their original `typeId`,
with a comment explaining that saved diagrams reference `typeId` in their stored `graph_data` JSON.
The same rule must apply here, and it is load-bearing in a way worth stating plainly: changing
`typeId: 'pipelines'` to `'basin-pipelines'` would make every saved diagram containing that node —
including the `data-pipeline` blueprint in `src/blueprints.ts`, which uses `pipelines`, `r2-sql` and
`r2-data-catalog` — resolve to an unknown type. The user-facing surface (`label`, `description`,
`icon`, `docLinks`) is what changes.

**Icons are the one genuine blocker.** `src/icons/` in the docs repo still ships `pipelines.svg`,
`r2-sql.svg` and `r2-data-catalog.svg`, and has **no** `basin*.svg` or `k2.svg`. The icon set has
not caught up with the rename. The existing vendored copies therefore remain the correct artwork
for the renamed products, and any new product whose icon is absent cannot be added until artwork
exists. Icons that *are* available for plausible additions: `agent-memory.svg`, `artifacts.svg`,
`dynamic-workers.svg`, `flagship.svg`, `web-search.svg`, `realtime-kit.svg`, `realtime-sfu.svg`,
`realtime-turn.svg`, `moq.svg`.

**Candidate new products** from the Developer platform group not currently in the catalogue:
Agent Memory, Artifacts, Dynamic Workers, Flagship, Web Search API, K2, Basin, RealtimeKit,
Realtime SFU, TURN Service, MoQ, Cloudflare Wallets, Agent Lee. Not all of these are architecture-
diagram nodes — Agent Lee is a dashboard copilot and `cf` is a CLI — so the list needs judgement
rather than wholesale adoption.

**Two tests pin the current state** and will need updating together with the catalogue:
`tests/worker/catalog.test.ts` asserts `NODE_TYPES` has exactly 42 entries, and it asserts every
`svg`-kind icon name resolves to a real file under `src/client/icons/`. The latter is the guard that
makes an icon-less product addition fail loudly rather than render blank.

### 3.3 Plan

Treat this as two separable changes, and do the renames first — they are unambiguous, evidenced, and
carry no artwork dependency.

**Stage 1 — corrections to existing entries (no new products).**

1. Relabel the three Basin products in `src/catalog.ts`, keeping each `typeId` untouched and adding
   the same style of comment the `autorag` and `browser-rendering` entries already carry, naming the
   former product so the next reader understands why id and label disagree:
   - `pipelines` → label "Basin Pipelines", doc URL `/basin-pipelines/`
   - `r2-sql` → label "Basin SQL", doc URL `/basin-sql/`
   - `r2-data-catalog` → label "Basin Catalog", doc URL `/basin-catalog/`
2. Audit every remaining entry's `label` and `docLinks` against its `directory` YAML entry, and fix
   any other drift the audit turns up. `analytics-engine` is worth checking specifically: the
   registry calls it "Workers Analytics Engine" at `/analytics/analytics-engine/`.
3. Update the blueprint node labels in `src/blueprints.ts` that spell the old names
   (`label: 'Pipelines'`, `'R2 Data Catalog'`, `'R2 SQL'`) and the `data-pipeline` blueprint's
   description prose, which names "R2 SQL" in a sentence.
4. Keep the existing vendored icons. They are still Cloudflare's current artwork for these products;
   re-vendor only if and when `basin*.svg` appears upstream.

**Stage 2 — new products, gated on artwork.**

5. Add only products that are genuinely diagrammable components and have an icon available. On
   current evidence that means Agent Memory, Artifacts, Dynamic Workers, Flagship and Web Search API
   are addable; K2 and Basin are **not**, because no icon exists for either. Record that explicitly
   in the spec so the omission reads as a decision rather than an oversight, and revisit when the
   icons land. For each addition: vendor the SVG byte-identically from
   `~/repos/cloudflare/cloudflare-docs/src/icons/` into `src/client/icons/`, and take the
   description from the registry's `meta.description`.
6. Assign each new product a category from the existing six. Agent Memory and Web Search API are
   `ai`; Artifacts is `storage`; Dynamic Workers is `compute`; Flagship is `compute`.

**Across both stages.**

7. Update the `NODE_TYPES` length assertion in `tests/worker/catalog.test.ts` to the new count. The
   existing icon-resolution, doc-link-shape and category tests then cover the additions for free.
8. Add a test asserting that the `typeId`s referenced by every blueprint resolve in `NODE_TYPE_MAP`.
   This is the regression that a careless rename would cause, and nothing currently catches it.
9. Check `src/worker/domain/ai/catalog-context.ts`, which feeds the catalogue to the assistant, so
   the AI is offered current names rather than retired ones.
10. Note in the demo `README.md` that product labels track the `directory` collection in
    `cloudflare/cloudflare-docs`, so the next person refreshing this list knows where the authority
    lives instead of searching the docs site by hand.

### 3.4 Outcome

Done. The three Basin renames and nine new products landed in `src/catalog.ts`, taking `NODE_TYPES`
from 42 to 51 entries:

| Product        | Category | Note                                   |
| -------------- | -------- | -------------------------------------- |
| Agent Memory   | `ai`     | new                                    |
| Web Search API | `ai`     | new                                    |
| Artifacts      | `storage`| new                                    |
| Dynamic Workers| `compute`| new                                    |
| Flagship       | `compute`| new                                    |
| RealtimeKit    | `media`  | new                                    |
| Realtime SFU   | `media`  | new                                    |
| TURN Service   | `media`  | new                                    |
| MoQ            | `media`  | new                                    |
| Basin Pipelines| `storage`| renamed, `typeId` stays `pipelines`    |
| Basin SQL      | `storage`| renamed, `typeId` stays `r2-sql`       |
| Basin Catalog  | `storage`| renamed, `typeId` stays `r2-data-catalog` |

Each icon was vendored byte-identically from `cloudflare/cloudflare-docs`. `cf`, Agent Lee and
Cloudflare Wallets were deliberately excluded; K2 and Basin are deferred to follow-on 4.

Two things turned up that the plan had not anticipated:

**All four Realtime icons are the same file.** `realtime.svg`, `realtime-kit.svg`,
`realtime-sfu.svg` and `realtime-turn.svg` are byte-identical in Cloudflare's own icon set. This is
consistent with the collisions the catalogue already documents, so the glyph is used as-is and the
note on `NODE_TYPES` now lists the Realtime family among them.

**A pre-existing theming defect surfaced.** `app.css` set `fill: currentColor` on the root `<svg>`
only, but a handful of official icons paint their shapes with a literal `fill="#000"` — a
presentation attribute on the shape beats an inherited value, so those icons rendered solid black:
invisible on a dark-theme node and ignoring the category colour on every theme. This already
affected the shipped `ai-search` icon and would have affected the new `dynamic-workers` one. Fixed
with a shape-level override excluding `fill="none"`, which is what keeps outline-drawn icons such as
`artifacts` from being filled into solid blobs. A `fill` inside a `<clipPath>` (as in `pipelines`)
is inert, since the renderer uses only the clip shape's geometry.

## 4. Products awaiting an official icon

### 4.1 Observation

Two current Developer platform products could not be added to the catalogue during follow-on 3,
because Cloudflare's own icon set has no glyph for either:

- **K2** — "A durable event stream" (`/k2/`), registered with `additional_groups: [Storage]`.
- **Basin** — "A serverless data analytics platform for ingesting, managing, and querying Apache
  Iceberg tables stored in R2" (`/basin/`), the umbrella product over Basin Pipelines, Basin SQL and
  Basin Catalog.

Both have documentation and a `src/content/directory/*.yaml` registry entry, so they are genuinely
published products rather than unannounced ones.

### 4.2 Investigation notes

`~/repos/cloudflare/cloudflare-docs/src/icons/` (checked at `0017e51a28`, 2026-10-09) contains no
`k2.svg`, no `basin.svg`, and none of `basin-pipelines.svg`, `basin-sql.svg` or
`basin-catalog.svg` — the icon set has not caught up with the Basin rename at all. The three
renamed products therefore still use their pre-rename artwork (`pipelines.svg`, `r2-sql.svg`,
`r2-data-catalog.svg`), which remains correct because it is still the only artwork Cloudflare
publishes for them.

Adding a product without an icon is not a cosmetic compromise. `ProductIcon` returns `null` when it
cannot resolve a name, so the node would render as label-only — reading as a broken node rather
than a deliberate one — and `tests/worker/catalog.test.ts` fails any `svg`-kind icon name with no
file behind it. Substituting a lookalike glyph was rejected as actively misleading: K2 and Basin are
distinct products, and borrowing another product's icon would assert a relationship that does not
exist.

Whether Basin should become a canvas node at all is a separate question worth deciding on its
merits. It is an umbrella over three products already in the catalogue, so a diagram containing
Basin *and* Basin Pipelines would be ambiguous about what is actually deployed. K2 has no such
problem and should simply be added once its glyph exists.

### 4.3 Plan

Deliberately deferred, not forgotten. The trigger is upstream artwork, so the work is small and
entirely mechanical once it lands.

1. **Re-check `cloudflare/cloudflare-docs` for `k2.svg` and `basin*.svg`** when next refreshing the
   catalogue. A `git pull` in that checkout followed by `ls src/icons | grep -E 'k2|basin'` is the
   whole check.
2. **When `k2.svg` appears**, add K2 as a `storage` node — matching its registry
   `additional_groups: [Storage]` — vendoring the glyph byte-identically and taking the description
   from the registry's `meta.description`. Bump the `NODE_TYPES` length assertion.
3. **When `basin*.svg` appears**, first decide whether Basin belongs on a canvas at all given the
   umbrella ambiguity above; if it does, add it as `storage`. Separately, re-vendor the three Basin
   product icons so the artwork matches the names already shipped, replacing `pipelines.svg`,
   `r2-sql.svg` and `r2-data-catalog.svg` in place. The filenames may stay as they are — they are
   referenced by `svgIcon(...)` calls, not by product name — but renaming them alongside a comment
   update would read better, and `typeId` must still not change.
4. **Leave the `typeId` values alone regardless.** The saved-diagram compatibility rule in the
   `NODE_TYPES` documentation applies to artwork refreshes exactly as it does to renames.
