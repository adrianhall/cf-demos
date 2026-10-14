# Validating Ignite CRM's deployed MCP endpoint

The browser app, the tool catalogue, tool authorization, idempotency, audit channel, and the MCP
protocol itself all have automated offline coverage. One part cannot: **Cloudflare Access Managed
OAuth**. Managed OAuth is an Access-edge capability; local development reaches `/mcp` with a
development JWT through the same Worker policy list, proving the Worker's half but not the browser
sign-in, Dynamic Client Registration, token refresh, or Access policy re-evaluation.

This is the operator runbook for that live-only gap. Run it after a deployment that changes the MCP
surface, `infra/access.tf`, or the pinned `agents` / `@modelcontextprotocol/*` packages. Writing
this file is not evidence that it passed: record a dated result at the end only after completing it
against a deployment.

## Safety and prerequisites

1. Deploy first: `pnpm deploy` from `cf-terraform-demos/ignite-crm`.
2. Get the hostname without copying an environment-specific value into this file:

   ```sh
   terraform -chdir=infra output -raw hostname
   ```

   Below, call it `<hostname>` and use `https://<hostname>/mcp`.

3. Use a real identity that can authenticate through the deployed Access application. Use an
   **owner** for the disposable write step and a separately suspended identity for the refusal step.
4. Use a remote HTTP MCP client that supports OAuth 2.1 Dynamic Client Registration. OpenCode is the
   reference client; another conforming client is acceptable.
5. Create only disposable CRM records. Do not put customer data, tokens, or OAuth client secrets in
   a transcript, screenshot, issue, commit, or this document.

The Access token lifetime is 15 minutes and the grant session is 336 hours. Plan the refresh test
before beginning: it needs a connected client left idle for more than 15 minutes.

## Step 0 — Confirm the Access application

In **Zero Trust → Access → Applications**, open the application Terraform created for Ignite CRM and
confirm all of the following before blaming the Worker:

- **Managed OAuth** is enabled.
- **Dynamic Client Registration** is enabled, including the loopback/localhost allowance. Native MCP
  clients use a `http://127.0.0.1:…` callback; Managed OAuth's HTTPS-only explicit URI list cannot
  express that, so the loopback allowance is intentional.
- `/mcp*` is covered by this application, with no competing Access application shadowing it.
- The application has the expected 15-minute access-token lifetime and 336-hour grant session.

A missing Managed OAuth setting usually looks like an HTML login redirect to an MCP client. That is
not a client protocol defect: turn Managed OAuth on and retry registration.

## Step 1 — Connect and authorize

Configure a remote Streamable HTTP MCP server at:

```text
https://<hostname>/mcp
```

On first use, the client should discover OAuth metadata, dynamically register a loopback client, and
open a browser. Sign in as the owner identity.

**Expected:** the browser completes the same Access login as the CRM editor, redirects to the
client's loopback callback, and the client reports a connected MCP server. The client must not need
a manually copied bearer token.

If registration is rejected, record the redirect URI from the client. It must be loopback or
localhost; rejecting any other redirect is intended.

## Step 2 — Confirm the capability-filtered catalogue

Initialize the connection and list tools. Confirm that a signed-in owner sees the read and write
catalogue expected for their roles. Then connect a read-only identity and confirm that write tools
are absent from its advertised list.

This is not the authorization proof — the Data Worker is authoritative even if a model calls a
hidden tool — but it proves the Access identity made it to the Worker and the client completed
discovery.

## Step 3 — Call one read and one disposable write

With the owner connection:

1. **Read:** call `whoami` and one CRM read, such as `pipeline_summary` or `search_customers`.
   Confirm the result matches the signed-in identity and does not include an Access token.
2. **Write:** create a disposable note linked to a disposable contact or company, using a unique
   title such as `MCP validation <UTC timestamp>`. Supply the required `idempotencyKey` exactly
   once.
3. Repeat the identical tool call with the **same** idempotency key. Confirm exactly one note
   exists: the second response is the recorded replay, not a duplicate.
4. Open the browser CRM and confirm the note is visible on its linked record. Then open **Audit
   trail** and confirm the created event names the authenticated actor and has channel **`mcp`**.
   The audit row must not include the note body or an OAuth token.

Remove the disposable record only if an ordinary CRM workflow permits it. Ignite CRM deliberately
does not expose note deletion in its first release, so use harmless validation wording and leave the
record as audit evidence rather than bypassing the application's lifecycle.

## Step 4 — Confirm silent refresh and suspension refusal

Leave the owner client connected and idle for **more than 15 minutes**. Call `whoami` or
`pipeline_summary` again.

**Expected:** the call succeeds without another interactive browser login; the client silently
refreshes within the 336-hour grant session.

For policy revocation, suspend a disposable test user in **Team** (or through the documented admin
workflow), wait for one access-token lifetime, and call a read tool through that user's existing MCP
connection.

**Expected:** Access or the Worker refuses the call. Do not accept a cached successful response as
proof; make a new call after the refresh window. Restore the user's status afterwards if this was a
shared test identity.

## Step 5 — Confirm bounded-cost failure behaviour

The Terraform-owned AI Gateway applies a **30 requests / 60 seconds sliding-window** limit and a
**$2 / 24-hour sliding spend cap** to chat model calls. MCP tools do not invoke the model, so
validate these limits through the browser chat panel, not through an MCP request.

In a non-production validation deployment, temporarily lower the Gateway rate limit or make enough
read-only chat turns to reach it. Confirm:

1. The panel gives a safe unavailable/temporary-limit message — never a provider stack trace, a tool
   result, or another user's data.
2. No mutation is attempted after a refused model call. In particular, do **not** auto-retry an
   approval continuation: a user must start a fresh action after recovery.
3. After the Gateway window resets or the temporary limit is restored, a manually initiated read
   turn works again.

Do not intentionally exhaust the $2 production spend cap. The cap is an account-cost guard, not a
demo exercise.

## Step 6 — Tear down or record retained evidence

If this was a disposable deployment, run `pnpm teardown`. It deletes the Application Worker first
(which also retires the chat Durable Object namespace), then the Data Worker, then Terraform-owned
resources including the AI Gateway and Access controls.

If the deployment remains as a demo, leave the Disposable-note title and its audit row as the only
validation evidence. Disconnect the MCP client; Dynamic Client Registration records accumulate in
Access and should be pruned according to the Zero Trust team's policy.

## Result record

Record this outside source control, or in the deployment ticket — never with tokens or customer
data:

| Field                                               | Result                |
| --------------------------------------------------- | --------------------- |
| UTC date / operator                                 |                       |
| Deployment hostname                                 |                       |
| MCP client and version                              |                       |
| Managed OAuth + DCR                                 | pass / fail           |
| Owner catalogue / read / write / idempotency replay | pass / fail           |
| Audit row (`channel = mcp`)                         | pass / fail           |
| Silent refresh after 15 minutes                     | pass / fail           |
| Suspended user refusal                              | pass / fail           |
| Chat rate-limit recovery (non-production only)      | pass / fail / not run |
| Teardown or retained demo evidence                  |                       |
| Notes / follow-up issue                             |                       |
