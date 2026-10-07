# Presenting Architect

A 15–20 minute Layer 1 walkthrough. See [`README.md`](README.md) for setup/lifecycle and
[`EXPLAIN-DEMO.md`](EXPLAIN-DEMO.md) for the architecture behind each step.

## Before the presentation

1. Deploy with `pnpm deploy`; do not use the local emulator for claims about real Access routing.
2. Have one ordinary identity and the identity matching `ADMIN_EMAIL` available.
3. Open the deployed application, Zero Trust Access applications, D1 console and Worker logs in
   separate tabs. Keep a private window signed out for the anonymous share step.
4. Confirm teardown is planned: `pnpm teardown` deletes the Worker before destroying bindings.

## Opening sentence

> Architect uses one hostname for a public gallery, authenticated editing, and digest-only anonymous
> shares, while D1 remains the authoritative copy of every diagram.

## 1. One hostname, two Access postures (2 minutes)

1. Open `/` and `/blueprints` signed out. Both are public.
2. Open `/app`. Cloudflare Access intercepts the real document navigation before the SPA runs.
3. In Zero Trust, show the hostname-wide bypass application and narrower authenticated destinations.
4. Explain that `/api/shares/:token` is deliberately omitted from authenticated destinations, while
   every management API has `redirect: false` and receives Worker-side JWT audience validation.

## 2. Create and edit (5 minutes)

1. Sign in and choose **+ New Diagram** → **API Gateway**.
2. In the create dialog, point out initial focus, labelled fields, Escape/Cancel/close equivalence,
   and the real miniature React Flow preview.
3. Create the diagram. The seven-node blueprint is centred and fitted on first render.
4. Add a product from the service palette by keyboard activation, then edit its label/description.
5. Use **Connect nodes** with only the keyboard. This native-form route is the WCAG alternative to
   dragging React Flow handles.
6. Use **Auto layout**, then Undo. Mention that this is the first moment the browser downloads ELK;
   it is not part of the initial bundle and never runs in the Worker.
7. Narrow the window and toggle both side panels: they overlay the full-width canvas rather than
   squeezing it.
8. Wait for the status bar to report the autosave, then reload to prove D1 persistence.

## 3. Dashboard and sharing (4 minutes)

1. Return to My Diagrams. Click the preview area—not only the title—to show the whole card link,
   while its overflow menu remains a separate control.
2. Duplicate a diagram, then delete the copy through the focus-managed confirmation dialog.
3. Open a diagram, choose **Share** → **Create link**, and copy it. Explain that this is the only
   response that contains the raw token.
4. Open the link in the private window: no Access challenge, read-only canvas, current graph.
5. Edit the owner copy and reload the share to show it is a live pointer, not a snapshot.
6. Revoke it, reload the private window, and show the same non-enumerating 404 used for malformed,
   unknown, revoked and deleted targets.
7. In D1, show the 64-character `token_digest` and `revoked_at`; the raw token is absent. KV also
   uses the digest as its key and is only a rebuildable lookup cache.

## 4. Export and appearance (3 minutes)

1. Export PNG and SVG: both frame graph bounds rather than the current pan/zoom.
2. Export the project ZIP and show its `cf`-based typed configuration. This is the one deliberate
   departure from the older source's Wrangler scaffold.
3. Enter print mode, cancel the native print dialog, and use **Back**. Editor chrome and the
   previous colour scheme return.
4. Cycle system → light → dark. Explain that native `light-dark()` must survive production CSS
   minification or the in-app override silently stops working.

## 5. Administration and defence in depth (3 minutes)

1. As an ordinary identity, show there is no Admin link and direct `/app/admin` access is refused.
2. As `ADMIN_EMAIL`, open Admin. The user directory is an observation surface, not an authorization
   source; there is deliberately no role column.
3. Preview a diagram by id. The projection shows graph content but never owner identity.
4. Delete it and show its share no longer resolves. The same application use case performs owner and
   moderation deletion, including share cleanup.

## Close

Point to three contracts:

- `BUG-AUDIT.md` maps all 35 inherited source defects to automated or browser evidence;
- `tests/worker/built-css.test.ts` checks production theme, accessibility and geometry rules;
- `tests/worker/built-bundle.test.ts` proves the 1.4 MB ELK engine is lazy.

Then run `pnpm teardown` in a scratch account. It removes the Worker first, then Terraform-owned D1,
KV, hostname and Access resources.

## Expected results

- Public routes work without identity; authenticated paths are intercepted and revalidated.
- Users can create, keyboard-connect, edit, autosave, reopen, duplicate and delete only their own
  diagrams.
- Anonymous links reveal one current diagram read-only, store no raw token and fail uniformly after
  revocation/deletion.
- Only `ADMIN_EMAIL` reaches any admin endpoint.
- Explicit appearance overrides work in the production build; responsive drawers preserve canvas
  width; reduced-motion preference stops directional edge animation.
- ELK is fetched only on Auto layout, not initial application load.
