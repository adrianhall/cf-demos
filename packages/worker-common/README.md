# `@demos/worker-common`

Shared Worker-tier building blocks used by every demo in this repository.

Each export here was duplicated across demos before it was extracted. Prefer these over a demo-local
reimplementation: they are defined and tested once, so a fix reaches every demo at the same time.

This package is **not** a general-purpose library. It ships TypeScript sources directly (no build
step) and is consumed only through the pnpm workspace.

## Install

Add it to a demo with the workspace protocol:

```jsonc
{
  "dependencies": {
    "@demos/worker-common": "workspace:*"
  }
}
```

## Exports

| Export                   | Purpose                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `createAccessMiddleware` | Cloudflare Access middleware reading its Audience tag from `ACCESS_AUD`. |
| `createMeRouter`         | `/api/me` router reporting the verified identity's email.                |
| `currentIdentity`        | The full verified Access identity for a request.                         |
| `currentIdentityEmail`   | The verified identity's email, used as the per-user key.                 |
| `jsonBodyLimit`          | Middleware bounding request body size, answering RFC 9457 `400`.         |
| `readJsonBody`           | JSON body parser turning malformed input into RFC 9457 `400`.            |
| `upgradeRequired`        | Builds a `426 Upgrade Required` problem-details error.                   |

### Access middleware

Mount it on the whole application, ahead of every route. Pass a policy builder that threads the
audience into each policy, and gate development tokens on `import.meta.env.DEV` so a production
build statically disables them.

```ts
import { createAccessMiddleware } from '@demos/worker-common';
import { buildAccessPolicies } from '../access-policies';

export const accessMiddleware = createAccessMiddleware<AppBindings>({
  buildPolicies: buildAccessPolicies,
  enableDevTokens: import.meta.env.DEV
});

app.use(accessMiddleware);
```

The middleware fails the request when `ACCESS_AUD` is missing, rather than running without audience
validation. Bind it from a Terraform `access_aud` output in production and from
`infra/local-outputs.json` locally.

### Identity

```ts
import { currentIdentityEmail } from '@demos/worker-common';

todosRouter.get('/', async (context) =>
  context.json({ todos: await context.get('TODO_SERVICE').list(currentIdentityEmail(context)) })
);
```

Re-export it under a demo's own vocabulary when that reads better at the call site:

```ts
export { currentIdentityEmail as currentParticipant } from '@demos/worker-common';
```

### Body handling

```ts
import { jsonBodyLimit, readJsonBody } from '@demos/worker-common';

linksRouter.use(jsonBodyLimit()); // 8 KB default; pass a number to override

linksRouter.post('/', async (context) => {
  const link = await context.get('LINK_SERVICE').createLink(await readJsonBody(context.req.raw));
  return context.json({ link }, 201);
});
```

### `/api/me`

```ts
import { createMeRouter } from '@demos/worker-common';

app.route('/api/me', createMeRouter<AppBindings>());

// Narrow which verified identities may read it:
app.route('/api/me', createMeRouter<AppBindings>({ middleware: [requireAdmin] }));
```

## Commands

```bash
pnpm check   # types, formatting, lint
pnpm test    # unit tests
pnpm fix     # apply formatting and safe lint fixes
```
