# 05 — Security

Codeflare runs untrusted, model-generated code with network access, against real source, on behalf of
authenticated users. The security design is the product design; it is not a layer applied
afterwards.

## 1. Threat model

### What we defend against

| # | Threat                                                                                     | Primary control                                                        |
| - | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1 | A malicious or compromised npm dependency reads a credential from the container and exfiltrates it. | No credential is ever in the container. Egress is closed by default.   |
| 2 | Prompt injection in a README, issue, or source comment makes the agent push to an attacker's remote, or publish secrets. | Publishing is human-initiated only. Egress allowlist is per hostname, method, and path. |
| 3 | A user reaches another user's session, container, or branch.                                | Identity from Access only; ownership and membership checked in the domain tier; names derived server-side. |
| 4 | Code in a preview steals the Codeflare session cookie or calls the Codeflare API as the user.       | Separate origin, cookie scoping, no management routes on preview hostnames. |
| 5 | Code in one preview reads another preview's browser storage.                                 | One hostname per session, therefore one origin per session.            |
| 6 | An agent runs away and burns unbounded compute or model spend.                               | Per-session budgets enforced before each turn; idle sleep; bounded instance sizes. |
| 7 | An attacker replays or codeflares an Access JWT from a sibling application in the same team.     | `aud` claim verified against this application's AUD, not just signature. |
| 8 | An agent destroys work — force push, history rewrite, repo delete.                            | Those operations require explicit human approval; the agent's git token cannot push externally. |
| 9 | A credential leaks through logs, traces, error responses, or the transcript.                  | Structured redaction at the logging boundary; RFC 9457 errors; tool arguments redacted before persistence. |
| 10 | A man-in-the-middle on SSH publishing.                                                       | Pinned host key. `StrictHostKeyChecking=no` forbidden.                 |

### What we explicitly do not defend against

Stated so nobody assumes a guarantee that is not there.

- **A user attacking their own session.** A user with a terminal in their own container can do
  anything the container can do. That is the point of the terminal. The container is the unit of
  trust and it contains only that user's own work.
- **Cross-microVM escape.** We rely on Cloudflare's container isolation. Each instance is a microVM
  with its own kernel and network.
- **A malicious administrator.** An admin can configure remotes and read audit logs. Out of scope.
- **Model output quality.** An agent can write bad or insecure code. Review is the user's job;
  Codeflare makes the diff easy to read.

## 2. The central invariant

> **No model credential, git credential, cloud credential, or SSH private key is ever present in a
> container's filesystem, environment variables, process arguments, or git configuration.**

This is NFR-SEC-010. It is verified by an automated test, not by inspection.

Every container-to-outside interaction therefore follows one shape:

```text
container makes an unauthenticated request to a known hostname
   → intercepted by the Worker (enableInternet: false, no direct egress)
   → Worker validates hostname + method + path against an allowlist
   → Worker reads the secret from Secrets Store
   → Worker attaches it and forwards upstream
   → response returns to the container, credential-free
```

### The anti-pattern, named

Do not do this:

```sh
git clone https://${TOKEN}@github.com/acme/app.git     # ← forbidden
```

`git` persists that URL, token included, into `.git/config`. Every test, postinstall script, and
transitive dependency in the container can read it. The Cloudflare documentation calls this out
directly, and it is the most common way a system like this leaks.

Do this instead — the container clones with no credential, and the Worker adds one:

```ts
await this.ctx.container.interceptOutboundHttps('github.com', this.env.GIT_GATEWAY);
await this.ctx.container.exec(['git', 'clone', 'https://github.com/acme/app.git', '/workspace']);
```

## 3. Egress policy

### Defaults

Every container starts with `enableInternet: false`. There is no configuration that turns this on.

`enableInternet: true` with an `allowedHosts` allowlist is **not** an acceptable substitute:
outbound handlers only see ports 80 and 443, so with Internet access enabled, connections on any
other port leave directly. Only `false` plus handlers is a closed door.

### The allowlist

Each allowed destination is a separate outbound entrypoint with its own narrow rule.

| Destination                       | Allowed                                                        | Credential added                   | Notes                                                                  |
| --------------------------------- | -------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `gateway.ai.cloudflare.com`       | `POST` to this project's gateway path only                      | AI Gateway token                   | Only if a CLI agent runs in-container. An in-DO harness needs no container egress at all. |
| `<account>.artifacts.cloudflare.net` | `git-upload-pack` and `git-receive-pack` for **this project's repo only** | Short-lived repo-scoped token | Write scope only for the session's own branch.                    |
| `registry.npmjs.org`              | `GET` only                                                      | None                               | Enabled only during an install phase, then withdrawn.                  |
| `github.com` / `gitlab.com`       | `git-upload-pack` for the imported repo only, during import     | Provider token                     | **Never** `git-receive-pack`. Pushing happens outside the container.   |

Everything else: `403`.

### Two rules that carry most of the weight

1. **Deny `git-receive-pack` from the container.** Path-pinning the git gateway to `git-upload-pack`
   means the container is physically unable to push to an external remote, even with a token that
   would allow it. This turns FR-GIT-120 from a policy into a structural guarantee, and it defuses
   threat 2.
2. **Withdraw the registry after install.** `npm install` needs the registry; an agent editing code
   does not. The install phase enables the registry entrypoint, the phase ends, the entrypoint is
   removed. A dependency that wants to phone home has nowhere to call.

### Only ever add credentials to HTTPS

An outbound handler fetches with the scheme the container used. A credential attached to a plain
HTTP request crosses the Internet in clear text. Every handler checks the scheme and refuses to
attach a credential to `http:`.

## 4. Identity and authorization

### Chain of trust

```text
1. Cloudflare Access at the edge — hostname-based application, team policy
2. Worker: validate Cf-Access-Jwt-Assertion against the team JWKS
3. Worker: verify aud === this application's AUD          ← the step people skip
4. Domain: resolve email → project membership and role
5. Domain: check session.ownerEmail for session-scoped actions
6. Infrastructure: derive the DO key from the validated identity
```

Step 3 is not optional. Every Access application in a team shares one JWKS, so a token minted for an
unrelated application in the same team validates cryptographically. Without the `aud` check, any
colleague with access to any application in the team can call Codeflare's API.

### Why hostname-based, not Worker-level

Worker-level Access policies do not support WebSocket upgrades — they return 403. Codeflare's chat,
terminal, and file-event channels are all WebSockets. Codeflare therefore uses self-hosted hostname
applications:

| Application                  | Policy                                         |
| ---------------------------- | ---------------------------------------------- |
| `codeflare.example.com`          | Team policy (allow the Codeflare Access group)     |
| `*.preview.example.com`      | Team policy, separate application and session  |
| `codeflare.example.com/health`   | Bypass — explicitly public                     |
| `codeflare.example.com/` (landing) | Bypass — explicitly public                   |

The path policy list is a single shared definition used by both local development and the deployed
application, per root `AGENTS.md`.

### Names never come from the client

A request never selects a sandbox. The flow is always: authenticate, authorize, *then* derive.

```ts
// WRONG — the URL chooses which files you see
const sandbox = env.SESSION.getByName(url.pathname.split('/')[2]);

// RIGHT
const user = await requireAccessIdentity(request, env);          // steps 2–3
const session = await sessions.findById(sessionId);              // D1
authorizeSessionAccess(user, session);                           // steps 4–5, throws 403
const sandbox = env.SESSION.getByName(sessionKey(session));      // step 6
```

The Durable Object name decides which sandbox — and which saved snapshot — a request reaches. It
does not prove who is asking. Reusing a name or a snapshot across identities hands one user another
user's files.

### Local development

Access is emulated, never disabled, so the same authorization code runs locally and deployed. The
development-token bypass is gated on a build-time flag that is statically `false` in a production
build, so the bundler removes the branch entirely. A runtime environment-variable check is not
sufficient — it leaves the code path in the deployed bundle.

## 5. Preview isolation

Previews are the highest-risk surface, because a preview renders agent-written code in the user's
browser.

| Control                      | Requirement                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| Separate origin              | `<session>.preview.<preview-domain>`, on a zone distinct from the application domain. Path-prefix previews on the app origin are forbidden. |
| Separate origin per session  | One hostname per session, so browser storage and any cookies are isolated between previews.    |
| Cookie scoping               | The Codeflare session cookie is `Host-only` to the application hostname and is never sent to a preview. |
| Access on previews           | The wildcard preview hostname is a separate Access application with the same team policy.       |
| No management routes         | Session-management endpoints exist only on the application hostname. Code in a preview cannot call them from its own origin. |
| No app credential forwarding | The preview proxy strips `Cookie` and `Authorization` from the application origin before forwarding to the container. |
| Frame isolation              | The UI embeds the preview in an `<iframe>` with a restrictive `sandbox` attribute and no `allow-same-origin` relative to the app origin. |
| Teardown                     | Stopping or archiving a session removes its hostname mapping, DNS binding, and Access entry (FR-PREV-090). |

## 6. Secrets management

| Secret                    | Stored in                | Read by                        | Ever in a container? |
| ------------------------- | ------------------------ | ------------------------------ | -------------------- |
| AI Gateway token          | Secrets Store            | Worker, per model call         | **No**               |
| GitHub token              | Secrets Store            | Git gateway entrypoint         | **No**               |
| GitLab token              | Secrets Store            | Git gateway entrypoint         | **No**               |
| SSH private key           | Secrets Store            | Publish worker only            | **No**               |
| Artifacts repo token      | Minted on demand, short-lived | Passed as a header via the gateway | **No**          |
| Access JWKS / AUD         | Worker configuration     | Access middleware              | No (not a secret)    |

Rules:

- No secret in `cloudflare.config.ts`, in a committed file, in a command-line argument, or in a log
  line.
- Artifacts tokens are minted per operation with the shortest workable TTL — 900 s for a read, 3600 s
  for a session's write lifetime — and re-minted rather than stored.
- `secrets.required` in the Worker configuration makes a deploy fail if a secret is absent, rather
  than deploying something broken.
- A `Remote` domain object holds a `secretRef`, never a secret. Make the alternative
  unrepresentable in the type system.

### SSH publishing

The one case where a private key must reach a git client. It is handled without putting the key in a
session container:

1. Publishing runs in a **dedicated ephemeral container**, not the session container, started only
   for the publish operation.
2. The Worker fetches the key from Secrets Store and writes it into that container's in-memory
   filesystem at `0600` immediately before the push.
3. A pinned `known_hosts` entry is written alongside it. `StrictHostKeyChecking` stays at `yes`.
4. The container is `destroy()`ed immediately after the push — successful or not.
5. The publish container's egress allows exactly one host, the configured remote, and nothing else.

The agent never has access to this container, and the session container never sees the key.

## 7. Approval gating

Certain operations require an explicit human decision. Gating is implemented in the harness's
`beforeToolCall` hook so no tool can bypass it.

| Operation                                       | Gate                                            |
| ----------------------------------------------- | ----------------------------------------------- |
| Deleting a file outside `/workspace`             | Approval                                        |
| `git push --force`, `reset --hard`, history rewrite | Approval                                     |
| Deleting a branch other than its own             | Approval                                        |
| Publishing to an external remote                 | **Human-initiated only**; not an agent tool     |
| Changing project configuration                   | **Human-initiated only**; not an agent tool     |
| Any command matching a configured danger pattern | Approval                                        |
| Continuing after a budget breach                 | Approval, with an explicit budget increase      |

A pending approval persists in Durable Object storage, so it survives eviction and is still there
when the user reconnects.

## 8. Data handling

| Concern            | Position                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Source code        | Stays in the Cloudflare account. Leaves only to a user-configured remote, on an explicit human action. |
| Model traffic      | Source content is sent to the configured model provider through AI Gateway. The README must state this plainly. |
| Transcripts        | In Durable Object SQLite, deleted with the session.                                                  |
| Logs              | Structured and redacted. A secret pattern is replaced at the logging boundary, not filtered downstream. |
| Errors            | RFC 9457 `application/problem+json`. No stack trace, internal path, binding name, or hostname leaves a deployed build. |
| Data localization | Artifacts jurisdiction (`eu` / `us`) is chosen at namespace creation and cannot be changed. Decide before creating it. |

## 9. Security checklist

Every line is signed off before Codeflare is considered done. Each maps to a test in
[12-testing.md](./12-testing.md).

### Credentials

- [ ] An automated test asserts no credential pattern appears in a container's environment,
      `/workspace/.git/config`, process list, or filesystem after a full session.
- [ ] Every outbound handler refuses to attach a credential to an `http:` request.
- [ ] No secret appears in any log line, trace attribute, or error response.
- [ ] Artifacts tokens are short-lived and minted per operation.
- [ ] The SSH key exists only inside an ephemeral publish container, never a session container.

### Egress

- [ ] Every container starts with `enableInternet: false`, asserted in a test.
- [ ] A request from a container to a non-allowlisted host returns 403.
- [ ] `git-receive-pack` from a session container is denied.
- [ ] The npm registry entrypoint is withdrawn once the install phase ends.

### Identity

- [ ] A request with no Access JWT is rejected.
- [ ] A request with a JWT whose `aud` belongs to a sibling application is rejected.
- [ ] A request for a session the caller does not own returns 403, not 404-by-accident.
- [ ] No sandbox, repo, or snapshot name is derived from client input.
- [ ] The development bypass branch is absent from a production bundle (asserted by inspecting the
      built output, not by reading the source).

### Previews

- [ ] A preview is served from a different origin than the application.
- [ ] The application session cookie is not sent to a preview hostname.
- [ ] Preview hostnames are behind Access.
- [ ] No session-management route answers on a preview hostname.
- [ ] Archiving a session removes its hostname, DNS binding, and Access entry.

### Agent

- [ ] A destructive git operation without approval is refused.
- [ ] An agent cannot publish to an external remote.
- [ ] A turn started over budget is refused.
- [ ] Tool arguments are redacted before persistence.

### Operations

- [ ] `pnpm teardown` leaves no container, Artifacts repo, Access application, DNS record, or DO
      namespace behind.
- [ ] Every external call has a timeout and a bounded retry.
- [ ] Error responses are RFC 9457 and leak nothing.
