# Spike 06: Vue Diagram Editor Report

Run: 2026-08-07. This disposable spike ran only on localhost. It created no
Cloudflare resources and used no Terraform, Cloudflare API, remote binding, or
`wrangler dev --remote`.

## Resolved Versions

| Package/runtime | Exact resolved version |
| --- | --- |
| Node.js | 26.7.0 |
| npm | 11.19.0 |
| Vue | 3.5.40 |
| Vuetify | 4.1.6 |
| Vite | 8.1.5 |
| TypeScript | 7.0.2 |
| Vitest | 4.1.10 |
| Vue Test Utils | 2.4.11 |
| `@vue-flow/core` | 1.48.2 |
| `@vue-flow/background` | 1.3.2 |
| `@vue-flow/controls` | 1.1.3 |
| ELK.js | 0.12.0 |
| Wrangler | 4.115.0 |
| workerd, bundled by Wrangler | 1.20260722.1 |

`npm view` established that `@vue-flow/core@1.48.2` requires Vue `^3.3.0`, so
the repository's Vue 3.5.40 is compatible. `@vue-flow/background@1.3.3` does
not exist; npm's current release is 1.3.2, which is the lockfile pin used here.

## Source-Verified Findings

- Vue Flow is a Vue-native dependency: the resolved core package declares Vue,
  not React, as its peer dependency. The page builds with Vue 3, Vuetify, Vite,
  and TypeScript with no React dependency.
- The shipped Vue Flow types expose `ViewportTransform` (`x`, `y`, `zoom`) and
  `project(position)`, which transforms browser client coordinates into graph
  coordinates. `DiagramCanvas.vue` uses `project()` for palette drops.
- The library's current generic order is `Node<Data, CustomEvents, Type>` and
  `Edge<Data, CustomEvents, Type>`; the spike's aliases encode the node and
  edge type unions in the third parameter. This avoided an incorrect older
  generic shape during initial type checking.
- `wrangler@4.115.0` reports workerd `1.20260722.1`. That binary rejects a
  compatibility date later than `2026-07-29`; the local-only configuration is
  pinned to that newest supported date. The initial `2026-08-07` attempt failed
  before the Worker started, then succeeded after this correction.

### Graph JSON Contract

The persisted contract is `GraphDocument` in `src/graph/types.ts`:

```json
{
  "version": 1,
  "nodes": [
    {
      "id": "workers",
      "type": "product",
      "position": { "x": 300, "y": 180 },
      "data": {
        "productId": "workers",
        "label": "Workers API",
        "description": "Serves the application"
      }
    },
    {
      "id": "browser",
      "type": "actor",
      "position": { "x": 40, "y": 180 },
      "data": { "kind": "external-actor", "label": "Customer browser" }
    }
  ],
  "edges": [
    {
      "id": "request",
      "source": "browser",
      "target": "workers",
      "type": "request",
      "data": { "relationship": "request", "label": "HTTPS request" }
    }
  ],
  "viewport": { "x": 0, "y": 0, "zoom": 1 }
}
```

The curated palette contains exactly `workers`, `d1`, `r2`, `kv`, and
`workflows`. The initial document has one `external-actor` and two labeled,
semantic edge types: `request` and `event`. `serializeGraph()` and
`parseGraph()` preserve the versioned document, and `saveGraph()`/`restoreGraph()`
store it under the local-only `architect-editor-spike-06` browser key.

### Coordinate Conversion

The shared cursor protocol should send graph-space coordinates, never sender
screen coordinates. Given viewport `{ x: panX, y: panY, zoom }`:

```text
graphX = (screenX - panX) / zoom
graphY = (screenY - panY) / zoom
screenX = graphX * zoom + panX
screenY = graphY * zoom + panY
```

`screenToGraph()` and `graphToScreen()` implement those inverse transforms.
The automated test proves graph point `(420, 250)` round-trips under both
`{ x: 40, y: -20, zoom: 1 }` and `{ x: -300, y: 180, zoom: 1.75 }`, even though
the screen positions differ. Palette drops use Vue Flow's source-verified
equivalent `project({ clientX, clientY })`; remote cursors use `graphToScreen()`
for the receiving viewer's viewport.

### Component Boundaries

| Component/module | Responsibility |
| --- | --- |
| `App.vue` | Owns graph state, selection, local save/restore, ELK action, and every graph mutation guard. |
| `DiagramPalette.vue` | Renders the five catalog entries and emits a stable product id. |
| `DiagramCanvas.vue` | Adapts Vue Flow events, product drops, custom nodes/edges, viewport updates, and remote-cursor rendering to explicit emits. |
| `ProductNode.vue`, `ActorNode.vue`, `TypedEdge.vue` | Render product, external actor, and semantic/labeled edge visuals. |
| `PropertiesPanel.vue` | Renders selected-node fields and emits immutable node replacements. |
| `graph/*.ts` | Keeps catalog, document contract, storage, coordinate math, and ELK layout independent of Vue components. |

### Read-only Enforcement

Read-only is enforced at each mutation boundary, not just by visual styling:

- The canvas disables draggable nodes, connection handles, and selection.
- Canvas `v-model` setters discard node and edge updates in read-only mode.
- Palette drops, palette click additions, property panel emissions, and the
  ELK action all return early when read-only.
- Save, restore, and auto-layout controls are disabled; every editable form
  field is disabled.
- Pan, zoom, controls, and inspection remain enabled. Viewport movement is a
  viewer-local presentation action, not a node or edge document edit.

## Locally Verified Findings

| Command | Result |
| --- | --- |
| `npm install` | Completed and wrote the isolated lockfile. npm audit reported 3 transitive dependency advisories (2 moderate, 1 high); no audit remediation was applied to a disposable spike. |
| `npm run check:types` | Passed with strict TypeScript. |
| `npm run test` | Passed: 4 files, 7 tests. Tests cover five catalog entries, actor and two edge types, JSON round-trip, palette-node coordinate creation, read-only node/edge rejection, properties edit/disable behavior, viewport coordinate round-trip, and ELK positions/semantic preservation. |
| `npm run build` | Passed with 99 transformed modules in 910 ms. Output JavaScript is 1.714 MB / 539.52 kB gzip. Vite emitted its standard over-500 kB chunk warning. |
| `npm run start -- --host 127.0.0.1 --port 5174` plus local `curl /` | Vite was ready in 110 ms and returned the editor's `index.html`. |
| `npm run start:workerd` plus local `curl /` | `wrangler dev --local` served the built static assets at `http://localhost:8788`; `GET /` returned `200 OK` in 6 ms. No binding was declared or connected remotely. |

The test and runtime evidence are sufficient to choose Vue Flow for Phase 2's
focused editor. This spike intentionally does not assert real-browser pointer
geometry, multi-browser collaboration transport, Access, persistence beyond
one browser's local storage, or durable concurrency; those belong to later
phases/spikes.

### ELK Decision

**Do not include ELK in the initial architect demo bundle.** ELK's layered
layout produced finite positions for every node and preserved edge semantics in
the local test, so its correctness is suitable for a later opt-in layout
feature. However, the small three-node spike already produces a 539.52 kB gzip
JavaScript entry chunk with a static ELK import. The primary editor flow works
without auto-layout, so Phase 2 should omit it. If user feedback justifies it,
load ELK only after the user requests auto-layout and retain the same
`layoutGraph()` seam and test.

## Deployed Findings

None. No Worker was deployed, no Cloudflare endpoint was contacted, no
Terraform was run, and no Cloudflare resource was created or destroyed.

## Limitations And Follow-up

- The local page proves a canvas interaction model, not collaboration. Phase 4
  must transmit graph-space cursor coordinates at a bounded rate and keep the
  receiving viewport client-local.
- The JSON validator is intentionally shallow because it restores only this
  local spike's own saved document. Phase 2 needs shared, strict graph-schema
  validation before Durable Object persistence.
- The remote cursor is one fixed test cursor, not a WebSocket participant.
- Native HTML drag/drop is covered by the adapter and node-creation tests; a
  real browser interaction test was deliberately not added to this disposable
  local spike.
- The npm audit findings should be reassessed when dependencies are selected
  for the production demo rather than force-upgrading this isolated probe.
