# Validating the deployed MCP endpoint

One thing about this demo's remote MCP server cannot be tested offline, and it is the first thing a
real user meets: the **Cloudflare Access Managed OAuth round trip**. Everything else has automated
coverage — the tool catalogue, every tool's behaviour, the ownership rule across both transports,
the live-sync push, the absence of secret logging — against the real Workers runtime, real D1 and
real hibernatable WebSockets. None of it exercises Managed OAuth, because Managed OAuth is an
Access-edge feature with no local emulation. Local development authenticates `/mcp` with a
development JWT through the identical policy list, which proves the Worker's half and nothing about
Access's.

This document is the step-by-step check an operator performs against a real deployment to cover that
gap. Re-run it after any change to the MCP surface, to `infra/access.tf`'s `oauth_configuration`, or
to the pinned `agents` / `@modelcontextprotocol/server` versions.

Writing the runbook is not the same as running it. It is only evidence once somebody has worked
through it against a live deployment and recorded the result.

## What this is checking, and why it cannot be automated

Access resolves an MCP client's **opaque** OAuth token (`oauth:CvNoo…`) at its own edge and forwards
a signed `Cf-Access-Jwt-Assertion` header to the Worker. From the Worker's point of view, an
OAuth-authenticated agent is indistinguishable from a browser-authenticated user — which is exactly
why the Worker needs no OAuth code and why no Worker-level test can observe the exchange. The parts
that can fail are all on Access's side of that boundary:

- whether Dynamic Client Registration accepts the client's loopback redirect at all;
- whether the browser login completes and the client receives a usable token;
- whether a silent refresh succeeds once the short access token expires;
- whether policy re-evaluation on refresh revokes access as intended.

## Prerequisites

1. A completed `pnpm deploy`. Managed OAuth lives on the Access application Terraform owns, so it
   does not exist until `terraform apply` has run.
2. The deployed hostname:

   ```sh
   terraform -chdir=infra output -raw hostname
   ```

   Every step below writes this as `<hostname>`. Do not substitute a literal into a committed file:
   `pnpm check:naming` scans this document and will reject one.

3. An identity your Zero Trust team's identity provider will authenticate — the same identity that
   can sign in to the editor, because it is the same Access application.
4. An MCP client that supports OAuth against a remote HTTP server. OpenCode is the reference; any
   client implementing Dynamic Client Registration works.
5. A browser session you can watch the login complete in.

## Step 0 — Confirm the operator-visible Access settings

Before touching a client, confirm the deployment is in the state Terraform intends. In the Zero
Trust dashboard, open **Access → Applications** and the application named `<demo> app`:

- **OAuth / Managed OAuth is enabled.** This is the setting that turns Access itself into the OAuth
  2.1 authorization server. Without it, an MCP client is answered with a `302` to a login page that
  it can never follow, which surfaces as an unexplained connection failure rather than as an
  authentication prompt.
- **Dynamic Client Registration is enabled**, with both the loopback and localhost allowances on.
- **The access-token lifetime is 15 minutes and the grant session is 336 hours.**
- **`/mcp*` is in the destination list.** Everything not enumerated there falls through to the
  hostname-wide public bypass application, so a missing entry would make the endpoint anonymously
  reachable at the edge.

There should be exactly **one** application covering `/mcp*`. Access resolves the most specific
application for a request, so a second one would shadow this one and the two policy lists would then
have to be kept in step by review rather than by construction.

### Why `allow_any_on_loopback` rather than a narrow `allowed_uris`

This looks lax and is not. OpenCode's MCP OAuth client uses a fixed default loopback redirect,
`http://127.0.0.1:19876/mcp/oauth/callback`, and OAuth 2.1's native-app loopback exception means
agent harnesses generally redirect to a plain `http://127.0.0.1:…` address. Managed OAuth's
`allowed_uris` field **requires `https`**, so it cannot express a loopback redirect at all.
`allow_any_on_loopback` is therefore the only mechanism that admits such a client — not a lazier
alternative to a tighter rule. The narrowing that does the work is elsewhere: the identity still has
to pass the application's own policy, which is the same policy that guards the editor.

## Step 1 — Connect the client and complete the login

Point the client at `https://<hostname>/mcp` as a remote MCP server over HTTP.

On the first connection the client should discover Access's OAuth metadata, register itself through
Dynamic Client Registration, and open a browser window. Complete the login with your test identity.

**Expected:** the same login screen the editor itself uses, followed by a redirect back to the
client's loopback address and a connected server.

**If the browser never opens** and the client reports a redirect or an HTML response instead, check
Step 0's Managed OAuth toggle first — a `302` to a login page is precisely what a client sees when
Managed OAuth is off.

**If registration is refused**, read the client's redirect URI from its error output and confirm it
is a loopback or localhost address. Anything else is genuinely not admitted by this configuration,
and that is the intended behaviour rather than a fault.

## Step 2 — Confirm the catalogue arrived

Ask the client to list the tools the server offers. There should be exactly sixteen:

| Category       | Tools                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| Read           | `list_diagrams`, `get_diagram`                                                                            |
| Metadata       | `create_diagram`, `rename_diagram`, `delete_diagram`                                                      |
| Graph mutation | `add_node`, `update_node`, `remove_node`, `add_edge`, `update_edge`, `remove_edge`, `auto_layout_diagram` |
| Sharing        | `create_share_link`, `get_share_status`, `revoke_share_link`                                              |
| Export         | `export_diagram`                                                                                          |

The offline suite already asserts this catalogue against the handler. Seeing it here proves
something different: that the tokens Access issued actually reach the Worker, and that the
client-side discovery completed.

## Step 3 — Call one tool from every category

The point of covering every category is that each one reaches a different part of the system: a read
touches D1 only; a mutation additionally reaches the Durable Object; sharing reaches KV; and an
export runs the scaffold generator or the pure SVG transform. A failure in any one of them is
invisible from the others.

Work through these in order, against a scratch diagram you are happy to delete.

1. **Read.** Ask for your diagrams. Expect your own and nobody else's.
2. **Metadata.** Ask it to create a diagram called `MCP validation`. Note the id it returns.
3. **Graph mutation — with an editor open.** Open that diagram in the browser editor and leave the
   tab visible. Then ask the client to add a Worker node called `API` and a D1 node called
   `Database`, and connect them with a service-binding edge.

   **Expected:** the canvas updates **live**, without a reload, and shows the "Updated by an agent"
   notice. This is the one step where the browser and the agent have to be watched together, and it
   is the moment the whole design exists for.

4. **Sharing.** Ask it to create a share link. Read the returned URL back and open it in a private
   window: the anonymous read-only viewer should show the nodes the agent just added. Then ask for
   the share status — it must report that a link is active and **must not** reproduce the URL, since
   only a digest was kept.
5. **Export.** First ask it to download the diagram's Cloudflare project scaffold. Save the base64
   archive to a file, unzip it, and confirm the generated `cloudflare.config.ts` contains a D1
   binding matching the node the agent added.

   Then ask: _"Export this diagram as `mcp-validation.svg`, create `mcp-validation.md` with an
   Architecture heading and embed the SVG beneath it with useful alt text."_ Confirm all of the
   following rather than stopping at a plausible-looking string:

   - the `.svg` file begins with a standalone `<svg>` document and parses without an XML error;
   - it displays in a real browser, with the API and Database nodes both legible, connected by a
     blue dashed service-binding edge, and neither node nor label clipped by the viewBox;
   - opening `mcp-validation.md` in a Markdown preview displays that same picture rather than a
     broken-image placeholder; and
   - asking specifically for PNG makes the client direct you to the editor's Export button. PNG is
     still browser-only because it needs a raster renderer; SVG is the server-side vector format.

6. **Revoke and delete.** Ask it to revoke the share link, reload the private window, and confirm
   the same non-enumerating `404`. Then delete the diagram.

## Step 4 — Confirm the transport is distinguishable in the logs

Open **Workers → Logs** for the deployed Worker and filter for `diagram_updated`. The events from
Step 3 carry `via: "mcp"`. Make one edit in the browser editor and confirm the event for it carries
`via: "api"`.

One event name for one thing that happened, distinguished only by transport. This is what lets an
operator answer "did a person or an agent change this diagram" without a second event or a second
table.

Confirm also what is **not** there: no share token, no graph content and no email address appears in
any log line. The offline suite asserts this across the whole MCP surface; this is the confirmation
that the deployed logging transport did not add any of it back.

## Step 5 — Confirm the refresh

This is the step most easily skipped and the one that covers the configuration's actual security
claim. Leave the client connected and idle for longer than the access-token lifetime — more than
**15 minutes** — then call `list_diagrams` again.

**Expected:** the call succeeds with no new browser login. The client silently refreshed against the
336-hour grant session.

The short lifetime is load-bearing rather than a tuning preference: Access re-evaluates policy on
every silent refresh, so an identity removed from the policy loses access within one token lifetime
rather than at its next interactive login. If you want to confirm that directly, remove the test
identity from the application's policy, wait out one token lifetime, and confirm the next tool call
is refused.

## Step 6 — Tidy up

Delete any diagram created during the run, and disconnect the MCP client so its registered OAuth
client is no longer in use. Dynamic Client Registration creates a client record per harness; a
validation run that is repeated often will accumulate them, and they are worth pruning in the Zero
Trust dashboard.

## Recording the result

Note, with the date: the client and version used, whether each step passed, and anything that needed
a workaround. A step that needed a workaround is a defect in this demo or in the runbook, not an
acceptable outcome — the standard is that a presenter can run `DEMO.md` end to end without manual
intervention beyond what is written down.
