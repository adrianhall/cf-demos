# Cooperative Architect Drawing

Phase 1 establishes the secure deployment boundary for a cooperative architecture editor. The public landing and future anonymous share paths are protected by a hostname-wide Access bypass application. A more-specific Access application protects `/app*` and `/api/*`; the Worker independently validates that application's audience before serving the API.

The Worker and static Vue application deploy together. Static Assets provides SPA fallback while only `/api/*` and future `/shared/*` resolver traffic runs through Worker code. The local Vite Access plugin shares the same path policy and supplies two selectable identities, so the browser flow can be developed without a Cloudflare account.

Terraform owns the Worker registration, custom domain, Access resources, D1, R2, and KV. A bootstrap Worker deployment satisfies the custom-domain prerequisite; Wrangler owns later code deployments and bindings. The Worker explicitly depends on D1, R2, and KV so teardown deletes the Worker before bound resources. R2 is emptied before Terraform destroy.

The initial migration establishes D1 directory tables for diagrams, memberships, single-use invitation digests, publication metadata, and Workflow jobs. The `DiagramRoom` SQLite Durable Object and `ArchitectureWorkflow` are registered now but intentionally inert: later phases add document authority, WebSockets, and AI jobs without changing infrastructure ownership.

## Further Reading

- [Cloudflare Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/)
- [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Workers Workflows](https://developers.cloudflare.com/workflows/)
- [D1](https://developers.cloudflare.com/d1/), [R2](https://developers.cloudflare.com/r2/), and [Workers KV](https://developers.cloudflare.com/kv/)
