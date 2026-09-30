# 08 — Previews

## 1. Security boundary

A preview is not “another route in the app.” It is an untrusted web application authored by the
agent and executed in the user's browser. It gets a separate origin.

```text
Codeflare control plane:     https://codeflare.example.com
Session preview:         https://<session-id>.preview.codeflare.example.com

Different hostname → different browser origin → no shared local storage / cookies / service workers.
```

The preview zone should be a separate Cloudflare zone where possible: `codeflare-previews.example.com`
rather than `preview.codeflare.example.com`. This makes accidental cookie broadening harder and keeps
preview DNS/Access lifecycle distinct.

## 2. Routing and DNS

One proxied wildcard record receives every session hostname:

```text
Type: AAAA
Name: *
Content: 100::
Proxy: Proxied
Zone: codeflare-previews.example.com
```

The address is never contacted because a Worker route handles every request:

```text
*.codeflare-previews.example.com/* → Codeflare Worker
```

`cloudflare.config.ts` retains `workers_dev: true` so the control-plane workers.dev URL remains
available despite custom routes.

### Preview request algorithm

```ts
function previewRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const suffix = `.${env.PREVIEW_DOMAIN}`;

  if (!url.hostname.endsWith(suffix)) return notFound();
  const sessionLabel = url.hostname.slice(0, -suffix.length);
  if (!isDnsLabel(sessionLabel)) return notFound();

  // KV is a performance map, not authorization. Value is server-created only.
  const sessionKey = await env.PREVIEW_INDEX.get(`preview:${sessionLabel}`);
  if (!sessionKey) return notFound();

  // Preview Access policy has already authenticated edge traffic. The Worker also validates JWT.
  await requirePreviewAccessIdentity(request, env);

  url.protocol = 'http:';
  return env.SESSION.getByName(sessionKey).fetch(new Request(url, stripControlPlaneHeaders(request)));
}
```

The session label validation is deliberate. A host like `//another-host` must remain a path, never
turn into a redirect/SSRF target. Invalid labels yield 404, not a descriptive validation error.

## 3. Preview Durable Object behaviour

`SessionDO.fetch()` receives the proxied request and owns readiness.

### Start sequence

1. Confirm the request is a preview request for this session; no control-plane action belongs here.
2. Restore/start the session container if stopped.
3. Start the dev server if `DevServerState.status !== 'ready'`.
4. Poll `container.getTcpPort(port).fetch('http://container/')` until any HTTP response arrives,
   max 30 seconds.
5. Forward the original request **once** through `getTcpPort(port).fetch()`.

Do not retry a forwarded request. A retry might duplicate a `POST`.

### Dev server launch

The background server service must:

- use the project-declared `devCommand` and `devPort`;
- force/bake in `--host 0.0.0.0` for frameworks that otherwise bind localhost;
- capture stdout/stderr to `/workspace/.codeflare/logs/dev-server.log`;
- record pid, command, started time, and log path in DO SQLite;
- use a process group so a stop reliably kills child processes;
- check liveness before treating a process as ready;
- emit `preview.status-changed` events.

The process has to be launched independently of the HTTP handler that requested it. A server used as
the container main process would end the container on crash; a tracked background process is safer
for normal development semantics.

### Container survival

The preview’s request traffic ordinarily keeps the DO active, but a quiet browser does not. While a
dev server is marked live, the session alarm fires once a minute and re-establishes the inactivity
timeout. When the user deliberately stops the server, the alarm condition disappears.

An open preview must not keep a container alive indefinitely if nobody visits it; a project setting
controls the preview idle period (default 15 minutes), after which Codeflare snapshots the workspace,
stops the server/container, and reports `sleeping`. The next request restores it, restarts the dev
server, and may get a short “starting preview” response before reload succeeds.

## 4. WebSockets and HMR

`getTcpPort(port).fetch(request)` forwards Upgrade requests, so Vite, vinext, Next and similar HMR
websockets work as long as the original request headers are preserved.

Proxy rules:

- Preserve `Upgrade`, `Connection`, `Sec-WebSocket-*`, `Origin`, and `Host` where the dev server
  needs them.
- Strip Codeflare control-plane cookies and authorisation headers before forwarding.
- Do not rewrite path prefixes. The hostname model lets applications see their normal `/` base path.
- Set a response header identifying the session preview (`X-Codeflare-Preview`) only after ensuring it
  does not make its way to an upstream fetch from user code.

## 5. Access and iframe policy

### Access

The preview wildcard has a hostname-based Access application. It uses the same team policy as Codeflare,
but it is a distinct Access application and therefore a distinct audience. The Worker validates its
own preview AUD, not the control-plane AUD.

Do not use a Worker-level Access policy: it rejects WebSocket upgrades.

### Embedding

The Codeflare UI embeds the preview using:

```html
<iframe
  src="https://<session>.codeflare-previews.example.com/"
  sandbox="allow-forms allow-modals allow-popups allow-scripts allow-downloads"
  referrerpolicy="no-referrer"
  title="Session preview"
/>
```

No `allow-same-origin`: the preview needs no identity relationship with Codeflare. If a framework's HMR
or service worker requires it in practice, reassess through a security review; do not add it
casually.

Set a preview CSP that permits the expected dev-server websocket connection but denies framing by
arbitrary origins. Set `frame-ancestors https://codeflare.example.com` for normal team use.

## 6. User experience

The Preview pane renders:

- State pill: **Stopped**, **Starting**, **Ready**, **Crashed**, **Sleeping**.
- Open-in-new-tab control, retaining Access protection.
- Restart control (human action) with status feedback.
- Log-tail panel, max 200 lines streamed from the process log.
- URL copy control.
- A clear “preview code is untrusted” label.

A preview that fails to start gives the user the tail log and an actionable structured error, never a
blank iframe. A preview that sleeps can be woken with one button rather than requiring the user to
infer why it is gone.

## 7. Teardown

On archive/delete:

1. Stop the dev-server process group.
2. Remove `preview:<sessionId>` from KV.
3. Remove any per-session custom Access grant, if sharing is implemented.
4. Remove any session-specific DNS record if named records are used (the wildcard itself remains).
5. Destroy/snapshot the container according to session state.
6. Emit `preview.status-changed(stopped)`.

The wildcard zone route and baseline Access application are deployment-owned; individual session
mappings are application-owned.

## 8. Why not sandbox tunnels?

Sandbox SDK tunnels can make a quick `*.trycloudflare.com` URL or a persistent named tunnel. They
are a good fit for ad-hoc demos, but Codeflare uses a Worker proxy instead:

- Codeflare can validate Access and enforce project/session identity before every request.
- The preview stays behind the same audit and observability path.
- The proxy gives a stable separate-origin hostname with one DNS setup.
- Credentials and bindings remain in Worker code, not in the sandbox.

Tunnels remain a fallback for local-development ergonomics only; they are not part of the deployed
preview architecture.
