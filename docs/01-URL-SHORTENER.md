# Demo 1: URL Shortener

Directory: `demos/url-shortener`

Domain: `link.cfapps.uk`

Cloudflare products: Workers and Workers KV.

## Behavior

- Provide an admin page for creating, editing, and deleting short links.
- Redirect `https://link.cfapps.uk/l/<code>` to the configured destination.
- Write an informational structured log whenever a short link is used.

## Demo Flow

1. Create a short link to a customer website in the admin page.
2. Open the generated short URL and observe the redirect.
3. Open Workers Logs and locate the informational usage log.

## Implementation Plan

1. Create an independent `demos/url-shortener` demo using Vue 3, Vuetify,
   Pinia, Vue Router, Vite, Hono, and TypeScript.
2. Provision a Worker, Workers KV namespace, `link.cfapps.uk` custom domain,
   Workers Logs, and automatic tracing with Terraform.
3. Create a hostname-wide public Access bypass application plus a more-specific
   Access allow application for `/admin*` and `/api/links*`, limited to the
   configured administrator email address.
4. Generate `wrangler.jsonc` from Terraform outputs using the pinned
   `@adrianhall/cloudflare-scripts` release. Commit a template with local
   placeholder bindings so a clean checkout can build and test without cloud
   resources.
5. Store each link as JSON under a `link:<code>` KV key. Generate immutable,
   URL-safe codes with Web Crypto; allow administrators to edit only the
   destination URL.
6. Implement an authenticated CRUD API at `/api/links` and a public
   `GET /l/:code` redirect handler. Accept only validated HTTP(S) destination
   URLs and return RFC 9457 problem details for errors.
7. Return redirects as `302` responses with `Cache-Control: no-store`, ensuring
   link edits take effect and every use reaches the Worker. Emit an
   informational structured `short_link_used` log without unnecessary visitor
   data.
8. Validate the exact Cloudflare Access audience for protected Worker routes,
   and use the toolkit's development-only Access plugin for local browser
   development.
9. Build a focused, responsive administrator interface for creating, copying,
   editing, and deleting links. Configure static assets to run the Worker first
   for `/admin*`, `/api/*`, and `/l/*`.
10. Add unit, workerd integration, and Playwright browser tests for validation,
    CRUD, authenticated access, redirects, usage logging, and the complete
    demonstration workflow.
11. Provide single-command deployment and teardown scripts, plus complete
    operator, developer, and presenter documentation. Document Workers KV's
    eventual-consistency behavior for newly created or changed links.
12. Verify formatting, linting, type checking, tests, production build,
    Wrangler configuration, and Terraform formatting and validation.
