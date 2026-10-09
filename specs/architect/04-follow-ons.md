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
