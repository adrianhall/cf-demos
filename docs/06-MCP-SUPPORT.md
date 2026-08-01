# Demo 6 Follow-On: Enterprise MCP Server Connections

Status: Pre-planning notes only — **not** a phased implementation plan. Expand
this into one (following the Spikes → Scaffolding → one-phase-per-feature
shape of `docs/06-AGENTIC-CHAT.md`) only after that demo has shipped.

## Why This Is Not Part Of `docs/06-AGENTIC-CHAT.md`

The original backlog for demo 6 named a Cloudflare Access MCP server portal
integration as one bullet among many. `docs/06-AGENTIC-CHAT.md` removed it
(see that document's Non-Goals) for two reasons:

1. **Scope.** Demo 6 already carries an unusually large feature surface for
   one demo (dynamic routing, cost reconciliation, tools, skills, an admin
   console). Adding a real MCP client on top — not just a thin Access-portal
   wrapper — is its own project, not one more phase.
2. **The portal is the wrong scope anyway.** Cloudflare Access's MCP server
   portal product is a specific, opinionated on-ramp (centralize a handful of
   servers behind one Access-gated endpoint, with Access owning the OAuth
   dance). It is a reasonable product for its own use case, but it is
   narrower than what "enterprise-ready MCP support" should mean for an
   agent: connecting to **any** compliant remote MCP server an enterprise
   trusts, on the **current** MCP specification, with the agent itself
   (not a fronting Cloudflare product) governing which servers, which users,
   and which tools.

## Goal

Give `ChatAgent` (or its successor) first-party support for connecting to
external MCP servers — enterprise-approved and, optionally, per-user — over
the Agents SDK's own MCP client, targeting the **2026-07-28 MCP
specification** (stateless, session-free servers; elicitation) while
remaining compatible with legacy MCP servers still on the 2025-era protocol.
Tool results from connected servers should surface in `streamText()`'s
`tools` set exactly like the demo's own `writeMarkdown`/`getUrl` tools, and
every connection, tool call, and (where supported) elicitation should be
auditable.

## What Cloudflare Already Provides (Verified 2026-07-31)

The Agents SDK (`agents` package, `@cloudflare/ai-chat`'s `AIChatAgent`) has
grown real, non-experimental support for exactly this since demo 6's initial
research pass — this follow-on exists to use it deliberately, not to build a
client from scratch:

- **`this.addMcpServer(name, urlOrBinding, options?)`** on any `Agent`/
  `AIChatAgent` connects to a remote MCP server (Streamable HTTP) or, for a
  server running in the same account, an internal **RPC transport** binding
  (Durable-Object-to-Durable-Object, no network hop, no OAuth needed —
  appropriate only for first-party/internal servers, never third-party
  ones). Connections survive Durable Object hibernation automatically
  (binding name and props persist to storage).
- **`this.mcp.getAITools()`** exposes every connected server's tools as an
  `ai` SDK tool set, droppable straight into `streamText()`'s `tools` —
  the same integration point demo 6's own tools already use.
- **Automatic protocol negotiation.** As of Agents SDK v0.20.0, the client
  manager probes each server with `server/discover`; if the server speaks
  MCP 2026-07-28 it uses the new stateless protocol, and if not it falls
  back to the legacy `initialize` handshake **on the same connection and the
  same `addMcpServer()` call** — one code path handles both server
  generations, not two.
- **Elicitation support** (`this.mcp.configureElicitationHandlers({ form,
  url })`) lets a connected server ask the user for input or out-of-band
  consent mid-tool-call. This is a genuine enterprise requirement (a
  server-side OAuth step, a confirmation before a consequential action) that
  a naive client integration would otherwise have no way to surface.
- **Server-side**: if this project also means *exposing* an MCP server from
  this account (not just connecting to others), `createMcpHandler` from
  `agents/mcp/server` builds a stateless 2026-07-28 server with no
  protocol-session Durable Object required.

None of this was available (or was still experimental/portal-shaped) when
demo 6's own research pass first looked at MCP — it is worth re-verifying
currency again when this follow-on is actually scoped, since this is a
fast-moving part of the platform.

## Candidate Scope (Not Yet User Stories)

Rough shape only — turn these into real user stories with acceptance
criteria when this becomes a real plan:

- **Enterprise server catalog (admin-managed).** An admin registers approved
  MCP server URLs, mirroring the enterprise-skill catalog pattern demo 6's
  Phase 11 already establishes (D1 catalog row, admin-only write, everyone
  read). Every chat's agent connects to the enterprise set automatically.
- **Personal server connections (user-managed), if warranted.** A user adds
  their own server, visible only to their own chats — mirroring demo 6's
  personal-skill pattern. This needs a real security decision (below) before
  it is committed to, not an assumed yes.
- **Per-user OAuth for Streamable HTTP servers that require it.** Unlike the
  rejected Access-portal approach, this project's client owns the OAuth
  handshake directly (the Agents SDK's MCP client API, not Access). Needs a
  "Connect to `<server>`" UI action and durable per-(user, server) token
  storage, refreshed transparently.
- **Elicitation UI.** A chat-transcript-native way to render a server's
  form/URL elicitation request and collect the user's response, rather than
  auto-declining every one (the naive/default behavior).
- **Governance and observability.** Which servers exist, which users are
  connected to which, and a tool-call audit trail (server, tool, user, chat,
  outcome — never full input/output payloads, matching demo 6's existing
  `tool_invoked` logging discipline). An admin should be able to disable a
  server account-wide.
- **Internal RPC-transport servers**, if this account ever hosts its own
  first-party MCP servers (for example, a future demo's server) — lower
  latency, no OAuth, but explicitly **not** a substitute for the external,
  OAuth-bearing case above.

## Architecture Sketch

```
ChatAgent (AIChatAgent)
  onStart() → this.addMcpServer(name, url, { transport: "streamable-http" })
              for every enterprise server + this user's personal servers
  onChatMessage() → tools: { ...ownTools, ...this.mcp.getAITools() }
  this.mcp.configureElicitationHandlers({ form, url })
              → forward to the chat transcript, resolve on user response

D1 ── mcp_servers (enterprise/personal catalog, mirroring `skills`)
      mcp_connections (per-user OAuth/session state, if not held entirely
                        by the Agents SDK's own persisted connection state)
      mcp_tool_invocations (audit trail)
```

Whether per-user OAuth token state needs its **own** D1 table or is fully
covered by what the Agents SDK already persists per connection is exactly
the kind of question a real Spike (not this document) should answer.

## Key Risks And Open Questions (For The Real Plan's Spike Phase)

- **Security of user-added personal servers.** Letting a user point their
  own agent at an arbitrary URL is a real SSRF-adjacent and
  prompt-injection-adjacent risk (a malicious "MCP server" could return
  tool descriptions or elicitation requests crafted to manipulate the
  model). Decide whether personal connections exist at all, or whether
  every server — personal or enterprise — must pass through an admin
  allow-list first.
- **Elicitation UX** is unexplored in this codebase; a form/URL request
  arriving mid-turn needs a transcript-native pause-and-resume design
  compatible with `AIChatAgent`'s streaming model.
- **Where per-user OAuth tokens live and how they are protected** — this is
  a genuine secret, not a prompt; the design must guarantee the model never
  sees it, only tool results.
- **Verify currency of everything above again before scoping the real
  plan.** MCP support in the Agents SDK changed materially between this
  demo's initial research and now; it is likely to keep changing.

## Prerequisites

- `docs/06-AGENTIC-CHAT.md` implemented and shipped — this project reuses
  `ChatAgent`, its D1 conventions, its Access model, and its enterprise/
  personal catalog pattern from Phase 11 rather than inventing new ones.
- Re-verify, at the time this is actually scoped, that the Agents SDK's MCP
  client APIs referenced above are still current (retrieve fresh docs; do
  not trust this document's specifics without re-checking).

## Next Steps (When This Becomes A Real Plan)

1. Restate the candidate scope above as proper user stories with acceptance
   criteria (Section 5 style of `docs/06-AGENTIC-CHAT.md`).
2. Add a Spikes phase resolving the open questions above (protocol
   negotiation in practice, elicitation UX, personal-server security
   decision, OAuth token storage).
3. Write one feature phase per user story, each fully tested, tagged in git,
   following the same conventions `docs/06-AGENTIC-CHAT.md` established.
