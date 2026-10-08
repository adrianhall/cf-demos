# Presenting Architect

A 20–25 minute walkthrough. See [`README.md`](README.md) for setup/lifecycle and
[`EXPLAIN-DEMO.md`](EXPLAIN-DEMO.md) for the architecture behind each step.

## Before the presentation

1. Deploy with `pnpm deploy`; do not use the local emulator for claims about real Access routing.
2. Have one ordinary identity and the identity matching `ADMIN_EMAIL` available.
3. Open the deployed application, Zero Trust Access applications, D1 console and Worker logs in
   separate tabs. Keep a private window signed out for the anonymous share step.
4. **Connect your agent harness to `/mcp` and complete the OAuth login once, in advance.** The login
   works; watching somebody type a password does not make a point, and a first-time Dynamic Client
   Registration is the slowest thing in the whole demo. Walk through
   [`MCP-VALIDATION.md`](MCP-VALIDATION.md) beforehand if this deployment is new.
5. Arrange the editor and a terminal side by side on one screen for section 4. Its entire effect
   depends on both being visible at once.
6. Confirm teardown is planned: `pnpm teardown` deletes the Worker before destroying bindings.

## Opening sentence

> Architect uses one hostname for a public gallery, authenticated editing, and digest-only anonymous
> shares, while D1 remains the authoritative copy of every diagram — and an agent editing a diagram
> goes through exactly the same identity, the same ownership rule and the same services the browser
> does.

## 1. One hostname, two Access postures (2 minutes)

1. Open `/` and `/blueprints` signed out. Both are public.
2. Open `/app`. Cloudflare Access intercepts the real document navigation before the SPA runs.
3. In Zero Trust, show the hostname-wide bypass application and narrower authenticated destinations.
4. Explain that `/api/shares/:token` is deliberately omitted from authenticated destinations, while
   every management API has `redirect: false` and receives Worker-side JWT audience validation.
5. On the authenticated application, show `/mcp*` in the destination list and the Managed OAuth
   configuration beside it. One application, not two: an identity that can sign in to the editor can
   sign in to an agent session, and nobody else can — by construction rather than by keeping two
   policy lists in step.

## 2. Create and edit (5 minutes)

1. Sign in and choose **+ New Diagram** → **API Gateway**. The gallery holds 22 templates filtered
   by AI, Serverless, Media and Storage; 18 of them transcribe a published Cloudflare
   [Developer Platform reference architecture](https://developers.cloudflare.com/reference-architecture/by-solution/#developer-platform).
2. In the create dialog, point out initial focus, labelled fields, Escape/Cancel/close equivalence,
   the real miniature React Flow preview, and the link back to the reference architecture the
   template came from.
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

## 4. An agent editing the live canvas (5 minutes)

This is the centre of the demo, and the staging matters more than the words. Put the browser editor
and a terminal **side by side on one screen** before you start, with the diagram already open. The
point is not that an agent can call an API; it is that the canvas the audience is looking at changes
while nobody touches it.

1. Open a diagram in the editor and leave it visible. Say what the audience should watch: this tab,
   untouched, for the rest of the section.
2. In the terminal, start an agent session and connect it to `/mcp` on the deployed hostname —
   `terraform -chdir=infra output -raw hostname` has the value. Complete the Managed OAuth browser
   login when prompted. Point out that it is the **same login screen the editor itself uses**,
   because it is the same Access application: there is no second identity system for agents.
3. Ask it: _"Add a Worker node called API and a D1 node called Database, and connect them with a
   service-binding edge."_
4. **Watch the browser tab.** The nodes appear live, with the "Updated by an agent" notice. No
   reload, no polling. Say why the notice exists: a diagram that rewrites itself with no explanation
   reads as a bug rather than as the feature it is.
5. Ask it: _"Create a share link for this diagram."_ Read the returned URL back and open it in the
   private window. The anonymous read-only viewer already reflects the nodes the agent just added —
   a live pointer, not a snapshot. Then ask for the share status and show that it reports a link
   exists but **cannot** reproduce it. Only a digest was kept, and the tool's own description tells
   the model to say so rather than offering to look it up.
6. Ask it: _"Download this diagram's Cloudflare project scaffold."_ Open the resulting ZIP and show
   that its `cloudflare.config.ts` already contains the D1 binding for the node the agent added
   moments ago — the same generator the editor's Export button uses, running server-side.
7. Ask it: _"Export this diagram as `docs/architecture.svg` and add it to the Architecture section
   of my README."_ Open both files: the SVG is a real self-contained picture with the same nodes,
   connections and labels, and the Markdown references it with a normal image link. Then ask for a
   PNG. It should point you at the editor's Export button — vector markup is a pure graph transform,
   but pixels still need a browser renderer. That distinction is the tool description doing its job.
8. Open Workers Logs and filter for `diagram_updated`. The events from step 3 carry `via: "mcp"`.
   Make one edit in the browser and show the next event carrying `via: "api"`. One event name for
   one thing that happened, distinguished only by transport — which is how an operator answers "was
   that a person or an agent" without a second table.

If you have a minute spare, say what is **not** happening: the agent is not a second application
with its own ownership checks. Its tools call the same service the browser's API calls, in process,
so ask it for somebody else's diagram and it gets the same non-enumerating `404` the browser would.

> If Managed OAuth misbehaves on the day, the fallback is to run this section against `pnpm start`
> locally with a development JWT. Everything except the OAuth exchange is identical; say so rather
> than letting the audience think the login was skipped.

## 5. Export and appearance (3 minutes)

1. Export PNG and SVG: both frame graph bounds rather than the current pan/zoom.
2. Export the project ZIP and show its `cf`-based typed configuration. This is the one deliberate
   departure from the older source's Wrangler scaffold.
3. Enter print mode, cancel the native print dialog, and use **Back**. Editor chrome and the
   previous colour scheme return.
4. Cycle system → light → dark. Explain that native `light-dark()` must survive production CSS
   minification or the in-app override silently stops working.

## 6. Administration and defence in depth (3 minutes)

1. As an ordinary identity, show there is no Admin link and direct `/app/admin` access is refused.
2. As `ADMIN_EMAIL`, open Admin. The user directory is an observation surface, not an authorization
   source; there is deliberately no role column.
3. Preview a diagram by id. The projection shows graph content but never owner identity.
4. Delete it and show its share no longer resolves. The same application use case performs owner and
   moderation deletion, including share cleanup.

## Close

Point to four contracts:

- `BUG-AUDIT.md` maps all 35 inherited source defects to automated or browser evidence;
- `tests/worker/built-css.test.ts` checks production theme, accessibility and geometry rules;
- `tests/worker/built-bundle.test.ts` proves the 1.4 MB ELK engine is lazy;
- `tests/integration/mcp.test.ts` proves a non-owner receives the identical non-enumerating `404`
  from HTTP and from MCP — one ownership rule reached by two transports, rather than two rules that
  happen to agree.

Then run `pnpm teardown` in a scratch account. It removes the Worker first, then Terraform-owned D1,
KV, hostname and Access resources.

## Expected results

- Public routes work without identity; authenticated paths are intercepted and revalidated.
- Users can create, keyboard-connect, edit, autosave, reopen, duplicate and delete only their own
  diagrams.
- Anonymous links reveal one current diagram read-only, store no raw token and fail uniformly after
  revocation/deletion.
- Only `ADMIN_EMAIL` reaches any admin endpoint.
- An agent authenticates through the same Access application as the editor, acts only on its owner's
  diagrams, and its changes reach an open tab live with a visible explanation.
- `diagram_updated` events carry `via: "mcp"` for an agent's change and `via: "api"` for a
  browser's; no log line carries a share token, graph content or an email address.
- Explicit appearance overrides work in the production build; responsive drawers preserve canvas
  width; reduced-motion preference stops directional edge animation.
- ELK is fetched only on Auto layout, not initial application load.
