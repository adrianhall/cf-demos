# Ignite CRM — OAuth authorization service specification

## 1. Purpose and boundary

The OAuth Worker is Ignite CRM's MCP authorization server. It signs users in through the
installation's Cloudflare Access application, obtains explicit client/scope consent, issues and
refreshes resource-bound OAuth tokens, and validates MCP tokens over a private RPC binding.

It owns security protocol state only. It does not own users/roles (Permissions does), business data,
MCP tools, or SPA sessions. Browser API authentication continues to use Access directly.

## 2. Technology and deployment decision

Use `OAuthAuthorizationServer` from `@cloudflare/workers-oauth-provider` v1 and expose named
`AuthServer extends WorkerEntrypoint`. The MCP Worker uses `OAuthResourceServer` and binds to
`AuthServer.validateToken`; token validation never crosses public HTTP. This service specification
is independent even though the system document labels it `01h`: it is a separately deployed/tested
security service, not an implementation detail of MCP.

The Worker has:

- a dedicated authorization-server hostname/issuer;
- Terraform-owned `OAUTH_KV` for clients, grants, authorization codes, access/refresh tokens, state,
  and provider cleanup metadata;
- an Access application protecting human sign-in/consent paths without blocking protocol metadata or
  token endpoints that must follow OAuth semantics;
- `PERMISSIONS` binding for resolving the signed-in Access identity and denying suspended users at
  consent time.

The MCP resource has a distinct hostname and resource URI. Tokens are audience/resource bound to
that exact URI.

## 3. HTTP and RPC surfaces

Protocol paths follow provider v1 and current MCP OAuth metadata requirements:

- authorization-server metadata;
- `/authorize` consent/sign-in;
- `/token` authorization-code and refresh grants;
- client registration and Client ID Metadata Documents as supported by v1;
- revocation if supported by the selected provider version.

Only `/authorize` and consent submission are browser/Access surfaces. Protocol endpoints apply their
specified client/token authentication rather than an Access redirect.

```ts
export abstract class OAuthAuthorizationContract {
  abstract validateToken(resource: string, token: string): Promise<OAuthTokenValidation>;
}
```

The validation result contains subject user/email props, client ID, granted scopes, token/resource
metadata, and expiry. It never contains refresh-token material. MCP treats validation failure as 401
or insufficient-scope, not a domain ServiceError.

## 4. Consent and identity

- Access middleware validates JWT issuer/signature/time and exact OAuth application audience.
- Trusted identity headers are scrubbed/replaced as in API.
- `resolveActor(email)` requires an active/invited Permissions user; suspended/deleted/uninvited
  users cannot approve or refresh access.
- Consent displays escaped client name/URI, requested scopes, resource, and exact actions. It uses
  the provider v1 consent/upstream-sign-in helpers where available.
- CSRF token, OAuth state, PKCE, exact redirect-URI matching, issuer identification, resource
  indicators, and confused-deputy protections are mandatory.
- Consent approval is bound to authenticated user, client, resource, scopes, state, and short
  expiry.
- No wildcard redirect URI, implicit grant, password grant, or client secret in browser storage.

## 5. Storage and lifecycle

`OAUTH_KV` is owned exclusively by this Worker. Key layout remains provider-owned; application code
must not depend on undocumented keys. Configure explicit authorization-code, access-token,
refresh-token absolute/idle, state, and client-registration lifetimes after reviewing provider v1.
Expired-data cleanup uses the provider's resumable `purgeExpiredData()` mechanism through a
scheduled handler if required by the selected version; the schedule is part of OAuth Worker
configuration.

KV is accepted for provider security state despite eventual consistency because it is the supported
library design; business authorization is always rechecked in Permissions/domain services. Revoked
or expired token behavior is tested against provider guarantees.

Local development uses a dedicated local KV simulation and Access development identities; it never
touches production OAuth state.

## 6. Errors, logging, and security

- OAuth protocol errors use standard `error`/`error_description` without stack traces.
- Consent HTML has strict CSP, frame denial, nosniff, safe form action, and `__Host-` cookies.
- Logs include request ID, endpoint, client ID hash, grant type, outcome, scope names, and duration;
  never token/code/cookie values or raw OAuth props.
- Rate limiting is required on registration, authorize submission, token, and validation abuse
  paths. Exact Cloudflare rule ownership is Terraform/access infrastructure.
- `onError` logs the provider's internal reason privately and returns a generic protocol error.

## 7. Independent testing

### Unit

Consent escaping/rendering, CSRF/state binding, scope/resource display, redirect validation,
Access-to-Permissions resolution, error mapping, token redaction.

### Provider integration

Against local KV and signed development Access tokens:

- metadata discovery;
- PKCE authorization code flow;
- consent allow/deny and CSRF failure;
- token resource/audience and scopes;
- refresh, expiry, revocation/cleanup behavior;
- wrong redirect/client/resource/token;
- suspended user denied at new consent/refresh according to documented policy.

### Contract and MCP integration

`oauthAuthorizationContractTests` runs against real `AuthServer` and `FakeOAuthAuthorizationServer`
used by MCP. MCP integration validates tokens only through the service binding, tests wrong audience
and insufficient scope, and confirms no token appears in logs/results.

## 8. Acceptance criteria

- MCP token issuance and validation use provider v1 split authorization/resource-server APIs.
- OAuth Worker alone owns KV and token/grant state.
- Access establishes the human identity; Permissions establishes installation membership.
- Tokens are bound to the MCP resource and least scopes.
- The Worker can be tested independently with fake Permissions and local KV.

## 9. Open questions

1. Select explicit authorization-code, access-token, refresh absolute, and refresh idle TTL values.
2. Is dynamic client registration required for all target clients, or can Client ID Metadata
   Documents cover the tested set?
3. Should refresh be denied immediately when a user is suspended (recommended), and does provider v1
   expose the required hook without custom token-store coupling?
4. What account-level rate limits are suitable for a small installation?
5. Should owners see/revoke approved MCP clients in release-one UI? Current decision: no; provider
   revocation/protocol support only, with management UI deferred.
