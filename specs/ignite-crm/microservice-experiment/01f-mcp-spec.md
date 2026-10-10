# Ignite CRM — MCP Worker specification

## 1. Purpose and boundary

The MCP Worker gives an authenticated user's external LLM client a typed tool interface to Ignite
CRM. It is an alternate composition surface over the same domain RPC contracts as the API, not an AI
agent, chatbot, database, or privileged automation service.

A tool call acts as the authenticated human. It receives no extra permissions and may not accept an
actor email/user ID/role in tool arguments.

## 2. Technology decision

Use current `agents/mcp/server` `createMcpHandler` with `@modelcontextprotocol/server` SDK v2 and
Streamable HTTP at `/mcp`. It is stateless: create a fresh MCP server from the factory per request.
Wrap it with `OAuthResourceServer` from `@cloudflare/workers-oauth-provider` v1. Deprecated
`OAuthProvider`, feature-frozen `McpAgent`, SDK v1, Durable Object session state, GET listener
streams, and server-initiated autonomous actions are forbidden.

Configure explicit production `allowedHostnames`, browser `allowedOriginHostnames`, and CORS. Origin
validation is defense against DNS rebinding, not authentication.

## 3. Authentication and authorization

The endpoint follows MCP OAuth 2.1 using a separate OAuth authorization Worker. That Worker exposes
an `OAuthAuthorizationServer`, uses Cloudflare Access for upstream human sign-in/consent, and stores
grants/tokens/client registrations in its dedicated `OAUTH_KV`. MCP exposes an
`OAuthResourceServer`, publishes RFC 9728 metadata, and validates token resource/audience through
the typed `AUTH_SERVER.validateToken` RPC binding. It maps verified OAuth props to the Access email,
then calls Permissions `resolveActor`. OAuth KV is eventually consistent but token-validation
semantics and the provider library's design are accepted; business authorization remains RPC-based
RBAC.

Required OAuth scopes:

- `ignite:read` exposes read tools;
- `ignite:write` exposes mutation tools, but domain RBAC still decides;
- no admin/user-management MCP scope in release one.

Consent UI has CSRF protection, state binding, `__Host-` secure cookies, strict CSP, escaped client
metadata, and validated redirect URIs. Tokens/props are never logged or returned. Wrong audience,
issuer, expiry, or scope fails before tool execution.

## 4. Internal architecture

```text
OAuthResourceServer → createMcpHandler(createServer)
  → tool input schema and presenter
    → MCP coordinators
      → typed Permissions/CRM/Projects/Notes bindings
  → AUTH_SERVER token-validation binding (OAuth Worker)
```

Tool handlers remain thin. Coordinators are shared conceptually with API but return domain results;
MCP presenters create concise human-readable text plus structured content. MCP does not call API
over HTTP.

## 5. Tool catalogue

Tools are narrow verbs; do not expose generic SQL/query/update tools.

### Read (`ignite:read`)

| Tool                                          | Behavior                                         |
| --------------------------------------------- | ------------------------------------------------ |
| `ignite_whoami`                               | Identity, roles/capability summary; never token  |
| `ignite_search_customers`                     | Bounded contact/company search                   |
| `ignite_get_customer`                         | Composite customer context with partial warnings |
| `ignite_list_deals` / `ignite_get_deal`       | Filtered pipeline/deal detail                    |
| `ignite_action_stream`                        | Current user's follow-up queue                   |
| `ignite_list_projects` / `ignite_get_project` | Project detail and bounded tasks                 |
| `ignite_my_work`                              | Assigned task worklist                           |
| `ignite_search_notes` / `ignite_get_note`     | Full-text note lookup and raw Markdown           |
| `ignite_pipeline_summary`                     | Authorized aggregate                             |

### Write (`ignite:write` plus domain role)

| Tool                                                             | Behavior                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| `ignite_create_contact` / `ignite_update_contact`                | CRM contact mutations                                  |
| `ignite_create_deal` / `ignite_update_deal`                      | Deal mutations including status line/next action       |
| `ignite_set_deal_outcome`                                        | Win/loss with expected version                         |
| `ignite_convert_deal_to_project`                                 | Same idempotent saga as API                            |
| `ignite_log_activity`                                            | One call/meeting with multiple contacts, company, deal |
| `ignite_create_task` / `ignite_update_task` / `ignite_move_task` | Project task writes                                    |
| `ignite_create_note` / `ignite_update_note`                      | Markdown and validated multi-links                     |

Delete/user/role tools are excluded from release one to constrain agent blast radius. A user can use
the browser for destructive/admin operations.

## 6. Tool schemas and results

- Inputs use Zod-backed SDK schemas with descriptions, enums, maximums, examples, and no unknown
  fields.
- Update/delete-like tools require `expectedVersion`; write tools include optional `idempotencyKey`.
  If omitted, derive one from OAuth client ID + MCP request ID + tool name.
- Search/list default 20, max 50. Tool responses never dump an unbounded graph.
- Each success returns a short text summary and `structuredContent` matching an output schema.
- Results include IDs and versions so a later tool can safely mutate.
- Domain errors become `isError: true` with stable code, request ID, and safe recovery suggestion.
  `FORBIDDEN` does not reveal target existence.
- Partial composite reads label unavailable sections; writes never claim success for an uncommitted
  operation.

Tool descriptions explicitly tell models that free-text deal status is not the fixed outcome and
that notes are separate, multi-linked documents.

## 7. Dependency behavior

MCP owns the same reference-validation and deal-conversion coordinators as API (factored as
framework-neutral application modules). It groups note refs, validates through owner services, then
writes Notes. It never trusts model-provided validated refs.

Per-service call deadline is five seconds. Permissions outage fails closed. Read composites may be
partial under the same policy as API; mutation dependency failure is an error except documented
conversion `pending` state.

## 8. Testing

### Unit

Tool schema acceptance/rejection, scope-to-tool exposure, actor-field rejection, result formatting,
error mapping, bounded output, deterministic idempotency key, origin/host configuration.

### MCP protocol integration

Use an in-memory SDK v2 client/transport or HTTP calls to the stateless handler:

- initialize/list tools;
- call representative read/write tools;
- missing/wrong scope;
- malformed/unknown arguments;
- OAuth identity propagation;
- no GET session semantics required;
- JSON and Streamable HTTP response compatibility expected by target clients.

### Service integration

Bind typed fake services that pass contract suites; inject deny/outage/conflict/partial cases. Then
run one all-real local path for search and create note, and one conversion saga. Verify every tool
causes domain services to authorize and MCP cannot call management operations.

### Client compatibility smoke

Document and manually verify connection with OpenCode plus at least one of ChatGPT/Claude where
available. Automated CI remains offline and protocol-level.

## 9. Acceptance criteria

- Stateless current MCP handler; no deprecated `McpAgent`.
- OAuth identity maps to the same permissions user as browser Access identity.
- No generic query, delete, user-admin, or autonomous scheduled tool.
- Every write is RBAC checked, idempotent, version-aware, and audited by owner service.
- MCP and API coordinators have parity tests for shared use cases.

## 10. Open questions

1. Which non-OpenCode client is required for release acceptance: ChatGPT or Claude?
2. Should write scope be one broad `ignite:write` (current decision) or split CRM/projects/notes?
3. Should destructive tools remain excluded permanently or require MCP elicitation/approval later?
4. Should `ignite_get_customer` include full note Markdown or summaries/IDs only? Current decision:
   bounded recent note excerpts; full content via `ignite_get_note`.
5. What OAuth grant/refresh-token TTLs should be configured? Provider defaults are not accepted
   implicitly; implementation must record the reviewed values.
