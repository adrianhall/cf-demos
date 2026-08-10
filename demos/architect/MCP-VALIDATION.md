# MCP Server Validation Runbook

A step-by-step checklist for personally validating `demos/architect`'s remote MCP server
(`docs/09B-ARCHITECT-MCP.md`) end to end against a real deployment, using
[OpenCode](https://opencode.ai) as the MCP client — including the live-sync channel that pushes
an agent's edits into an already-open browser editor tab. This is the manual smoke check
`docs/09B-ARCHITECT-MCP.md`'s Phase 15 (item 16) calls for; it is not repeated automatically by
`npm test` because it requires a real deployed hostname and a real OAuth round trip.

For what each capability *teaches* and *why* it works this way, see
[`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md). For the full presenter script (browser-only features
included), see [`DEMO.md`](./DEMO.md). This document only covers the `/mcp` surface.

## What You Need

- The demo already deployed at `https://architect.cfapps.uk` (or your own `DEMO_NAME`/
  `DEMO_DOMAIN`) — see [`README.md`](./README.md) if not yet deployed.
- OpenCode installed locally, with write access to the `opencode.jsonc` you want to add the MCP
  server to (global `~/.config/opencode/opencode.jsonc`, or a project-local one — either works).
- A browser signed in (or able to sign in) to the same Cloudflare Access identity provider this
  deployment uses.
- Read access to the Cloudflare dashboard for this account (Zero Trust, Workers Logs, D1,
  Durable Objects) to confirm what happened server-side at each step.
- Two browser windows (or a normal window plus a private/incognito one) to observe live-sync
  fan-out to more than one open tab.

Substitute your own `DEMO_NAME`/`DEMO_DOMAIN` throughout if you deployed under a different
hostname than the default `architect.cfapps.uk`.

## 1. Confirm Managed OAuth Is Actually Enabled

Before touching OpenCode, confirm the server side is configured correctly — a much faster failure
signal than debugging a stuck OAuth flow later.

1. In the Cloudflare dashboard, open **Zero Trust** > **Access controls** > **Applications** >
   `architect app`.
2. Open its **Authentication** tab (or the equivalent **Edit** view) and confirm:
   - **Managed OAuth** (sometimes labeled **OAuth 2.1 authorization server**) is toggled **on**.
   - **Dynamic client registration** is enabled.
   - The application's **Destinations** list includes `architect.cfapps.uk/mcp*`.
3. If any of the above is missing, re-run `npm run deploy` from `demos/architect` (Terraform owns
   this configuration — see `infra/access.tf`) before continuing.

## 2. Add The Remote MCP Server To OpenCode

Add an entry under `mcp` in your `opencode.jsonc`. No `oauth` block is required — Access's Managed
OAuth advertises Dynamic Client Registration, which OpenCode detects and uses automatically:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "architect": {
      "type": "remote",
      "url": "https://architect.cfapps.uk/mcp",
      "enabled": true
    }
  }
}
```

Save the file. OpenCode reads `mcp` config on startup — restart any already-running OpenCode
session (TUI or `opencode serve`) after editing it.

## 3. Authenticate

1. Run:

   ```sh
   opencode mcp auth architect
   ```

2. Your default browser opens Cloudflare Access's real login screen at
   `https://architect.cfapps.uk/mcp` — the same screen `/app` uses. Sign in through your
   configured identity provider.
3. On success, Access redirects to OpenCode's local callback listener
   (`http://127.0.0.1:19876/mcp/oauth/callback` by default — confirm nothing else is bound to
   that port if the redirect hangs) and the terminal reports the server as authenticated.
4. Confirm both connectivity and auth status:

   ```sh
   opencode mcp list
   ```

   Expect `architect` listed as **connected** with a valid (non-expired) token. If it instead
   shows **needs_auth** or **failed**, see [Troubleshooting](#troubleshooting) before continuing.

## 4. Confirm The Tool Catalog Loaded

Ask OpenCode (in a session, TUI or CLI) something that requires no diagram to exist yet:

```
List my diagrams using the architect MCP server.
```

Expect an empty list (or your existing diagrams, if you've used the editor before) — not an
error. If OpenCode reports it has no matching tool, re-check step 2's config and restart OpenCode;
if it reports `401`, redo step 3.

The full tool catalog you should see available (`docs/09B-ARCHITECT-MCP.md`'s Remote MCP Tool
Catalog) is:

| Category | Tools |
| --- | --- |
| Diagram metadata | `list_diagrams`, `get_diagram`, `create_diagram`, `rename_diagram`, `delete_diagram` |
| Graph mutation | `add_node`, `update_node`, `remove_node`, `add_edge`, `update_edge`, `remove_edge`, `auto_layout_diagram` |
| Sharing | `create_share_link`, `get_share_status`, `revoke_share_link` |
| Export | `export_diagram` |

## 5. Validate Basic CRUD

```
Create a new blank diagram called "MCP Validation" using the architect MCP server.
```

Expect a confirmation with a diagram id. Keep that id handy — copy it from OpenCode's response or
note the title, since every following step operates on this same diagram.

```
Rename that diagram to "MCP Validation (renamed)".
```

Then confirm in the Cloudflare dashboard's D1 console (**Workers & Pages** > `architect` > **D1**
> `architect-db` > **Console**):

```sql
SELECT id, title, owner_email, updated_at FROM diagrams ORDER BY updated_at DESC LIMIT 1;
```

Confirm the row matches: correct title, and `owner_email` is *your* signed-in identity, not a
placeholder.

## 6. Validate Live Sync — The Core Collaborative-Editing Check

This is the part worth taking slowly: it proves an MCP tool call is visible, live, in a browser
tab you already have open, with no reload.

1. In a browser, sign in to `https://architect.cfapps.uk/app` as the **same identity** you
   authenticated OpenCode as in step 3.
2. Open the "MCP Validation (renamed)" diagram from your dashboard (or navigate directly to
   `/app/diagram/<id>` using the id from step 5). Leave this tab visible — do not touch or reload
   it for the rest of this section.
3. Open a **second** browser tab (or a private/incognito window, signed in as the same identity)
   to the same `/app/diagram/<id>` URL, positioned so you can see both tabs at once. This proves
   fan-out to *every* open tab, not just the first one.
4. Back in OpenCode, ask:

   ```
   Using the architect MCP server, add a Worker node called "API" at position (100, 100) to the
   "MCP Validation (renamed)" diagram.
   ```

5. Watch both browser tabs, without interacting with either: within a couple of seconds, expect
   the new "API" node to appear on the canvas in **both** tabs, each showing a dismissible
   "Updated by an agent" toast.
6. Ask OpenCode to connect two nodes, to confirm edge pushes work the same way:

   ```
   Add a D1 node called "Database" at position (300, 100), then connect API to Database with a
   service-binding edge.
   ```

   Confirm both new nodes and the edge appear live in both tabs again.
7. In the Cloudflare dashboard, open **Workers & Pages** > `architect` > **Durable Objects**, find
   the `DIAGRAM_SESSIONS` binding, and confirm an active instance exists — its name should be the
   diagram's own id from step 5. (Exact navigation depends on your dashboard version; the
   account-level **Durable Objects** view under **Workers & Pages** also lists live instances by
   class.)
8. In one of the two browser tabs, manually drag an existing node a few pixels (any small edit)
   and wait for the toolbar's "Saving…"/"Saved just now" status. This is the human-edit path
   (`PUT /api/diagrams/:id/graph`), not the MCP path — confirming the two write paths coexist
   without one clobbering the other's *unrelated* fields is part of what step 9 checks next.

## 7. Confirm `via: "mcp"` In Logs

1. In the Cloudflare dashboard, open **Workers & Pages** > `architect` > **Logs**.
2. Filter for `diagram_updated`.
3. Find the entries from step 6 (`add_node` calls) and confirm each carries `"via":"mcp"`.
4. Find the entry from step 6.8 (the manual drag) and confirm it instead carries `"via":"api"` —
   this is the field that lets a presenter (or you, right now) distinguish an agent-driven change
   from an ordinary browser edit in the same log stream.

## 8. Validate Auto-Layout's Documented Fallback

```
Run auto-layout on the "MCP Validation (renamed)" diagram using the architect MCP server.
```

Expect the tool to succeed and the nodes to rearrange into a simple grid in both open browser
tabs — **not** the same layered arrangement the editor's own **Layout ↓** toolbar button produces
(that one uses `elkjs`, which does not run in this Worker's runtime; see `docs/DECISIONS.md` #29
and the tool's own MCP description). A grid result here is correct, not a bug.

## 9. Validate Sharing Tools

```
Create a share link for the "MCP Validation (renamed)" diagram using the architect MCP server.
```

1. Copy the returned URL and open it in a private/incognito window with **no** Cloudflare Access
   sign-in. Confirm the diagram renders read-only with every node/edge from the previous steps
   already present.
2. Ask OpenCode:

   ```
   Check the share status of the "MCP Validation (renamed)" diagram.
   ```

   Confirm it reports the link as active, without showing the URL again (the server cannot
   recover a raw token after creation — see `EXPLAIN-DEMO.md`).
3. Ask OpenCode:

   ```
   Revoke the share link for the "MCP Validation (renamed)" diagram.
   ```

   Reload the private/incognito window's share URL and confirm it now reports the link was not
   found.

## 10. Validate Export

```
Export the "MCP Validation (renamed)" diagram as JSON using the architect MCP server.
```

Confirm the returned text is valid JSON containing the `API`/`Database` nodes and their edge.

```
Export the "MCP Validation (renamed)" diagram as a project scaffold.
```

Confirm OpenCode returns (and, depending on your client setup, saves) a base64-encoded ZIP.
Extract it and open `wrangler.toml` to confirm it contains a D1 binding section — the scaffold
generator noticed the `Database` node. Confirm no PNG/SVG export tool exists at all in the
catalog (`docs/09B-ARCHITECT-MCP.md`'s Non-Goals) — this is a deliberate gap, not something to
report as missing.

## 11. Validate Ownership Scoping (Security Check, Not Just A Feature Check)

1. If you have access to a **second** identity from the same identity provider, sign in to the
   editor as that identity (or use the dashboard's admin diagram id lookup, if you're the
   configured `ADMIN_EMAIL`) to get the id of a diagram you do **not** own.
2. Ask OpenCode:

   ```
   Get the diagram with id <someone else's diagram id> using the architect MCP server.
   ```

   Expect a "not found"-style response — never anything that leaks the diagram's title, graph, or
   confirms it exists but is "forbidden." Every MCP tool is owner-scoped identically to the REST
   API (`docs/09B-ARCHITECT-MCP.md`'s Access Model).
3. If you have no second identity available, skip this step — it is a defense-in-depth check, not
   required to confirm the demo works.

## 12. Clean Up

```
Delete the "MCP Validation (renamed)" diagram using the architect MCP server.
```

Confirm both open browser tabs from step 6 reflect the deletion (the dashboard, if you navigate
back to it, no longer lists it; reloading `/app/diagram/<id>` directly reports not found).
Optionally, revoke OpenCode's stored credentials for this server:

```sh
opencode mcp logout architect
```

## Troubleshooting

| Symptom | Cause and resolution |
| --- | --- |
| `opencode mcp auth architect` never opens a browser, or the terminal hangs | Confirm nothing else is listening on `127.0.0.1:19876` (OpenCode's default MCP OAuth callback port); free the port or set `mcp.architect.oauth.callbackPort`/`redirectUri` in `opencode.jsonc` to an alternate loopback port, then retry. |
| Browser opens but Access rejects the OAuth request | Re-check [step 1](#1-confirm-managed-oauth-is-actually-enabled) — Managed OAuth or dynamic client registration is likely disabled, or the `/mcp*` destination is missing from the Access application. |
| `opencode mcp list` shows `needs_auth` immediately after authenticating | The access token may have already expired (15-minute lifetime by design — see `infra/access.tf`). Re-run `opencode mcp auth architect`; a working client should otherwise refresh silently within its 14-day session. |
| Tool calls return `401` | Same as above, or the `architect app` Access application's `/mcp*` destination was removed by a later `terraform apply`; re-check step 1. |
| A tool call succeeds (OpenCode reports success) but neither browser tab updates | Confirm both tabs are actually on `/app/diagram/<id>` for the **same** diagram id the tool call used, and that the tab was already open *before* the tool call (the WebSocket only opens once a diagram loads in `DiagramCanvas`). Check the Durable Objects dashboard view for an active `DIAGRAM_SESSIONS` instance matching that id. |
| Live-sync update appears in one tab but not the other | Confirm the second tab is truly signed in and has the diagram open (not just a dashboard card); a stale tab from before this deployment's latest `npm run deploy` may need a hard reload once to pick up client code changes. |
| `auto_layout_diagram` produces the same visual result as the editor's **Layout ↓** button | Not expected — the MCP tool intentionally uses a simpler grid fallback (see step 8). If they look identical, it may simply be because the diagram is small enough that a grid and a layered layout coincide; try with 4+ nodes. |
| `export_diagram` with `format: "scaffold"` returns no D1 binding in `wrangler.toml` | Confirm the diagram actually has a D1 catalog node (`src/catalog.ts`'s `wranglerBinding`) before exporting — a diagram with no such node produces a scaffold with nothing to bind, matching the editor's own "Export as project" behavior. |
| A cross-owner `get_diagram` call in step 11 returns diagram content instead of "not found" | Stop and treat this as a real bug, not a config issue — file it before continuing any further validation; this is the demo's core ownership-scoping guarantee. |

See [`README.md`](./README.md)'s own Troubleshooting table for non-MCP issues (local dev sign-in,
`ADMIN_EMAIL`, deploy/migration failures).
