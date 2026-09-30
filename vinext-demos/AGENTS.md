# Vinext demo rules

These rules supplement the repository-wide [demo rules](../AGENTS.md) for every application in
`vinext-demos/`. They standardize the first working Vinext + Cloudflare Workers implementation so
new demos do not need to rediscover build, binding, or deployment conventions.

## Stack and dependencies

- Use the Vinext App Router (`app/`) with React and TypeScript. Prefer server components by default;
  mark a component `'use client'` only when it needs browser state, effects, events, or browser
  APIs.
- An App Router demo requires these deliberately pinned dependencies:
  - Runtime: `vinext`, `react`, `react-dom`, and `react-server-dom-webpack`.
  - Development: `@vitejs/plugin-rsc`, `@types/react`, and `@types/react-dom`.
- Use React Testing Library and `@testing-library/user-event` for UI tests. Test visible behavior
  and accessible controls; do not write tests against React component instances or implementation
  state.
- Keep UI state and same-origin HTTP client code in focused modules under `src/ui/`. Components do
  not access Cloudflare storage bindings directly.

## Vite and Cloudflare Workers

Use Vinext with the Cloudflare Vite plugin. This is the canonical plugin ordering and RSC setup for
an App Router project:

```ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { cloudflareAccessPlugin } from '@adrianhall/cloudflare-toolkit/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import { accessPolicies } from './src/access-policies.ts';

export default defineConfig({
  build: {
    // Vinext route handlers use this Workers-runtime module. Keep it external during the RSC build
    // so workerd, rather than Rolldown, resolves it at runtime.
    rolldownOptions: { external: ['cloudflare:workers'] }
  },
  plugins: [
    // This must precede cloudflare(), so local Access headers are injected before workerd dispatch.
    cloudflareAccessPlugin({ policies: accessPolicies }),
    vinext(),
    cloudflare({ viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] } })
  ]
});
```

- Do not register `@vitejs/plugin-rsc` yourself in `vite.config.ts`; Vinext registers it after it
  detects `app/`. It must still be installed as a dependency.
- Do not use the Pages Router or a separate Vite React plugin in a Vinext App Router demo unless a
  documented compatibility requirement demands it.
- `cloudflareAccessPlugin()` must come before `cloudflare()`. Feed both it and Worker-side Access
  validation from the same shared path-policy array.
- `cloudflare:workers` is available only in server route handlers, server components, and server
  actions. Never import it from a client component. It is the supported way to access deployed
  bindings; do not use `getPlatformProxy()`, `getRequestContext()`, or a custom Worker wrapper just
  to obtain bindings.

## Routing and tier boundaries

- Use `app/page.tsx` for the public root document and `app/<route>/page.tsx` for pages. A public
  root must render a genuinely public page; do not redirect it automatically to an
  Access-protected route, because that immediately turns a public visit into an authentication
  challenge. Link to the protected route instead. If a product genuinely requires a protected root,
  protect `/` explicitly and use a server-side/document redirect rather than client-only navigation.
- Implement HTTP endpoints as `app/api/**/route.ts` handlers. These are delivery-tier adapters: they
  parse framework route inputs, obtain Worker bindings with `env`, and delegate to the
  application/API layer. They must not construct repositories.
- Keep the four-tier dependency direction from the root rules visible:

  ```text
  React UI → Vinext route/API adapter → application/domain → infrastructure
  ```

- When preserving an existing Hono API layer, Vinext route handlers may adapt `Request` and `env`
  into that application. This keeps framework routing separate from authorization, validation, and
  domain logic.

## `cf` build-output control plane

Vinext demos use **only** the `cf` deployment control plane. Wrangler has been superseded by `cf`
and must never be introduced here: do not use Wrangler commands, add a Wrangler dependency, invoke
`vinext-cloudflare deploy`, or commit/embed a `wrangler.jsonc`.

If a genuine platform corner case appears to require Wrangler or an embedded Wrangler configuration,
do not silently work around this rule. Flag it explicitly in the demo README and in this family
`AGENTS.md` so product teams can address the missing `cf` capability.

### Known Vinext limitations

Flagged here per the rule above, so product teams can address them rather than each demo
rediscovering the workaround. Both are exercised by [`chat`](./chat).

**A WebSocket upgrade cannot be served from an `app/api/**/route.ts` handler.** Vinext 1.0.0's
route-handler pipeline reconstructs every handler response — `new Response(body, { status, headers })`
— to apply cache-control and cookie policy. A `101 Switching Protocols` cannot survive that:
`new Response()` rejects the status outright (*"Responses may only be constructed with status codes
in the range 200 to 599"*), reconstruction drops the `webSocket` property, and the pipeline's
`response.clone()` throws *"Cannot clone a response to a WebSocket handshake."*

Until Vinext passes a `101` through untouched, a demo needing WebSockets must dispatch the upgrade
from its own Worker entrypoint module before Vinext sees it. Keep that exception minimal and make
it provable:

- Key it on the **`Upgrade` header**, never on a path, so the framework keeps ownership of routing
  and a non-upgrade request to the socket route still travels the ordinary Vinext route.
- Send the upgrade into the same API application every route handler uses, so the same Access
  middleware authenticates it. Bypassing the framework must never mean bypassing authentication.
- Unit-test the dispatch so a later change cannot widen the exception unnoticed.

**A Durable Object class must be exported from the Worker entrypoint module.** `exports.durableObject`
binds a namespace to a named class export on the entry module, and `vinext/server/app-router-entry`
exports only its handler. Such a demo therefore names its own module as the `cf` entrypoint and
re-exports both Vinext's handler and the class.

**`new Request(request, { headers })` fails under Vinext.** The incoming object is Vinext's own
`Request` subclass, so passing it as the first argument makes the constructor stringify it as a URL
and throw `TypeError: Invalid URL: [object Request]`. Build from `request.url` with an explicit
`method` instead.

Use the `cf` + `cloudflare.config.ts` model when Terraform owns a Worker registration, bindings,
hostname, or Access resources:

- Import `vinext/server/app-router-entry` as the `cf` Worker entrypoint in `cloudflare.config.ts`.
- Use `cf dev`, `vite build --mode development`, and `cf deploy --prebuilt`.
- Generate bindings with `cf workers types --mode development`; include
  `.cloudflare/types/index.d.ts` in `tsconfig.json` and ignore `.cloudflare/`.
- Read real Terraform outputs only in production. Local development and offline tests use a
  committed placeholder-output fixture of the same shape.
- Let the Vinext router own all paths. Configure assets so static-asset routing cannot shadow
  `app/api/**` or other server routes.
- When the Access middleware uses a fail-closed `defaultAction: 'block'`, explicitly bypass every
  public route **and** the Vinext client-asset namespace (`/_next/*`). A public document cannot
  render for an unauthenticated visitor if its JavaScript and CSS chunks are blocked. Keep the root
  policy anchored (`/^\/$/u`) rather than using a broad `^\/` match that would make every path
  public.

## Access and local development

- Protect management pages and APIs with Cloudflare Access at the edge and validate the JWT plus the
  specific authorized identity in the application, as required by the root rules.
- Keep public redirect/content paths explicit bypasses. API policies use `redirect: false`; page
  policies use `redirect: true`.
- The local Access plugin recognizes browser navigations from their request headers. Validate page
  protection in a browser (or with navigation headers); a bare `curl` request is not a browser
  navigation and can be allowed through to let the application make its own decision.
- Development tokens must be gated by `import.meta.env.DEV` (or an equivalent build-time false
  production expression). Never enable them in a deployed build.

## Verification

- `check:types` regenerates platform types before TypeScript checks; `check` remains read-only.
- Test UI authorization gates, form and dialog behavior, error messages, and accessibility with a
  DOM test environment. Test Worker routes, validation, repositories, and Access outcomes in the
  Workers runtime independently.
- A production build may emit Vinext informational dynamic-import warnings. Treat build failure as a
  failure, but do not add configuration solely to suppress non-fatal Vinext diagnostics.
