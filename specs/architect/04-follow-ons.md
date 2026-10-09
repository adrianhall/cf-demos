# Follow-ons

## 1. Derive a safe default position for MCP-created nodes

### Observation

`add_node` requires its MCP caller to supply an explicit canvas position. The tool now explains
that a caller must put a node next to the nodes it will connect to and re-tier the diagram with
`auto_layout_diagram` afterwards, but that still asks an agent to reason about a visual property
from raw graph coordinates. In the API Gateway blueprint, adding an Orders D1 database at the open
storage-row position to the right of the existing D1 database avoided node overlap but made the new
Gateway-to-Orders edge pass behind Data Service. The stored edge was correct; the picture was easy
to misread as Data Service-to-Orders.

### 1.1 Investigation notes

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
