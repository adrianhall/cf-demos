# Architect Demo Script

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches.

> This script covers Phases 1–5 (scaffolding/Access, the diagram library/editor, read-only sharing, admin, and export/print/dark mode) of `docs/09-ARCHITECT.md`. Phase 6 is final verification and documentation polish, not a new user-facing capability, so it adds nothing further for this script to demonstrate.

## Demonstration Prerequisites

1. Deploy the demo with `npm run deploy` from `demos/architect`.
2. Confirm you can authenticate through the configured identity provider as at least two different identities, one of which matches this deployment's `ADMIN_EMAIL`.
3. Open a second browser window or tab to the Cloudflare dashboard at **Zero Trust** > **Access controls** > **Applications**.
4. Open a third browser window or tab to the Cloudflare dashboard's **D1** section, ready to open the `architect-db` database's console.
5. Sign out of, or use a private/incognito window for, the demo hostname so the first step shows the unauthenticated experience. Keep this window open throughout — it is reused later to demonstrate anonymous share viewing with no sign-in at all.

## Presentation Flow

1. In the signed-out/incognito browser, open `https://architect.cfapps.uk/`. Show the public landing page loads with no Access challenge.
2. Switch to the dashboard tab. Open **Zero Trust** > **Access controls** > **Applications** and show the two applications for this demo: a `bypass` application for the whole hostname, and an `allow` application scoped to `/app*`, `/api/me`, and `/api/diagrams*` destinations only — deliberately narrower than a bare `/api/*`, so the anonymous share resolver added later in this script stays covered by the `bypass` application instead.
3. Back in the browser, select **Open the editor**. Show that Cloudflare Access now intercepts the request with its login screen before the app shell renders.
4. Sign in as a non-administrator identity (for example `alice@example.com`). Show the app shell displays that email with no `(administrator)` marker.
5. Switch to the D1 tab. Open the `architect-db` database's console and run:

   ```sql
   SELECT email, display_name, first_seen_at, last_seen_at FROM users;
   ```

   Point out the row for the identity you just signed in as, and that `display_name` is `NULL` — Cloudflare Access's verified identity exposes only an email, not a display name.
6. Back in the browser, use the always-visible **Sign out** control.
7. Sign in as the identity matching this deployment's `ADMIN_EMAIL`. Show the app shell now displays `(administrator)` next to that email.
8. Re-run the D1 query from step 5 and show both identities' rows in the same `users` table, each upserted independently.
9. In a signed-out/incognito window, open `https://architect.cfapps.uk/blueprints`. Show the public blueprint gallery loads with no Access challenge, even though no one is signed in.
10. Back in the signed-in browser, from the dashboard (`/app`) select **+ New Diagram**. Pick the **API Gateway** blueprint card and show its live preview thumbnail.
11. In the create dialog, confirm the title, and select **Create Diagram**. Show the editor opens with the blueprint's nodes and edges already on the canvas.
12. Drag a product (for example **D1 Database**) from the left palette onto the canvas. Click it, and in the right-hand properties panel change its label and pick a documentation link to show it opens the real Cloudflare docs page.
13. Draw a new connection between two nodes by dragging from one node's handle to another's. Select the new edge and change its **Edge Type** in the properties panel; show the stroke style update live.
14. Select **Layout ↓** in the toolbar. Show ELK auto-layout re-arranges the nodes, and that **Undo** reverts it back to the manual layout.
15. Watch the status bar report "Saving…" then "Saved just now" a moment after the last change, with no explicit save action taken.
16. Switch to the D1 tab and run:

    ```sql
    SELECT id, title, owner_email, updated_at FROM diagrams;
    ```

    Point out the row for the diagram just edited, and that `updated_at` matches the autosave just observed.
17. Return to the dashboard (the toolbar's **Architect** logo). Show the new diagram's card with a live thumbnail preview matching the canvas.
18. Open the card's overflow menu and select **Duplicate**. Show a second card appears titled "… (copy)" with an identical preview.
19. Open the overflow menu on the original diagram and select **Delete**, confirm in the dialog, and show the card disappears from the grid.
20. Open the duplicated diagram (or any remaining diagram) in the editor. Select **Share** in the toolbar, then **Create link**. Point out the dialog's copy: the link is shown here once, right now, and copy it.
21. Switch to the signed-out/incognito window from the prerequisites and paste the link. Show the diagram renders read-only — no palette, no properties panel, no undo/redo — with no Access sign-in prompt at all.
22. Back in the signed-in browser, drag another product onto the canvas and wait for the autosave. Switch to the incognito window and reload the share link. Show the new node now appears there too, with no re-share needed — the link always reflects the diagram's current state.
23. Back in the signed-in browser, reopen **Share**. Point out it now shows the link is active without displaying the URL again (the server itself cannot recover it), then select **Revoke link**.
24. Switch to the incognito window and reload the same share URL. Show it now reports the link was not found.
25. Switch to the D1 tab and run:

    ```sql
    SELECT diagram_id, created_at, revoked_at FROM diagram_shares;
    ```

    Point out `token_digest` (select it too, if asked) is a 64-character SHA-256 hex digest, never the link's actual token — and that the row just revoked now has a `revoked_at` timestamp rather than being deleted.
26. Back in the signed-in browser, use **Sign out**, then sign in as a non-administrator identity (for example `alice@example.com`) again. Show that no **Admin** link appears in the header, and that opening `/app/admin` directly shows a "not available" message instead of the admin view.
27. Use **Sign out** again, then sign in as the identity matching `ADMIN_EMAIL`. Point out the **Admin** link now appears next to the `Architect` logo.
28. Select **Admin**. Show the user directory table listing every identity that has signed in so far in this session, each row's diagram count matching what was created earlier in this script.
29. Select **Next**/**Previous**, if enough identities exist to span a second page, to show the directory is paginated rather than loading every row at once.
30. Switch to the D1 tab and run:

    ```sql
    SELECT id, title, owner_email FROM diagrams;
    ```

    Copy the `id` of a diagram owned by the non-administrator identity from step 26.
31. Back in the admin view's **Diagram moderation** panel, paste that id into **Diagram id** and select **Open**. Show the diagram's title, description, and a read-only canvas preview render — and that no `owner_email` appears anywhere in this view.
32. Select **Delete diagram**, confirm in the dialog, and show the "Diagram deleted." confirmation.
33. Re-run the D1 query from step 30 and show the row is gone. Sign out and sign back in as the diagram's original owner; open `/app` and show the deleted diagram no longer appears in their dashboard.
34. Open any diagram with at least one node in the editor. Select **Export** in the toolbar, then **Export as PNG**. Open the downloaded file and show it matches the canvas, cropped tightly to the diagram's own bounds rather than the current on-screen pan/zoom.
35. Select **Export** again, then **Export as SVG**. Show the downloaded file opens as a crisp vector image at any zoom level.
36. Add a **Workers** node and a **D1 Database** node to the canvas if the current diagram doesn't already have both. Select **Export**, then **Export as project**. Show the download is a `.zip`; extract it and open `wrangler.toml` and `package.json` to point out the generated D1 binding section and the `db:migrate:local`/`deploy:db` scripts — a downloadable starter project, not this demo's own configuration.
37. Remove every Cloudflare service node from a diagram (or open a blank canvas), select **Export**, and show **Export as project** is disabled with a tooltip explaining there is nothing to scaffold.
38. Back in a diagram with content, select **Print** in the toolbar. Show the toolbar, palette, and properties panel disappear, replaced by a title/description overlay and a browser print dialog; select **Cancel** in that dialog, then select **← Back** to confirm the editor returns to normal.
39. Select the dark mode toggle in the toolbar (labeled **Dark mode** or **Light mode** depending on the current OS preference). Show the whole editor's colors invert immediately. Navigate to the dashboard (`/app`) and show the same preference already applied there — it is a single, page-independent preference, not reset by navigation.
40. Reload the page entirely (a full browser refresh, not a client-side navigation). Show the chosen theme is still applied immediately, with no visible flash of the other theme first.

## Expected Results

- Unauthenticated visitors see the public landing page at `/` and the public blueprint gallery at `/blueprints`; opening `/app` or calling `/api/me` unauthenticated redirects to (or returns `401` for) Cloudflare Access sign-in.
- Every signed-in identity sees its own email in the app shell; only the identity matching `ADMIN_EMAIL` sees the `(administrator)` marker.
- The `users` table in D1 gains one row per distinct identity that has ever signed in, with `last_seen_at` refreshed on every subsequent visit.
- A signed-in identity can create a diagram from a blueprint or a blank canvas, edit its nodes/edges/properties, see changes autosave within about a second, and reload the page with no data loss.
- The dashboard lists only the signed-in identity's own diagrams, and duplicate/delete act on exactly the selected diagram.
- A share link renders any diagram read-only for an anonymous visitor with no Access challenge, always reflects the diagram's current graph (no separate snapshot to fall out of sync), and stops resolving immediately once revoked.
- Only a SHA-256 digest of a share token is ever visible in D1 or Workers KV; the raw, working link is shown to the owner exactly once, at creation.
- The **Admin** nav link and `/app/admin` view are usable only by the identity matching `ADMIN_EMAIL`; every other identity is refused, both in the UI and by every `/api/admin/*` route (`403`).
- The admin user directory lists every identity that has ever signed in with an accurate, live diagram count per identity, paginated rather than loaded all at once.
- The admin diagram moderation panel can preview any diagram's title/description/graph by id without ever exposing its owner, and can delete it regardless of owner, cascading to revoke any of its active share links.
- Export as PNG/SVG downloads an image cropped to the diagram's own bounds, independent of the canvas's current pan/zoom; export as project downloads a `.zip` containing a working `wrangler.toml`-based starter project matching the diagram's Cloudflare service nodes, and is disabled when a diagram has no such node.
- Print mode replaces the editing UI with a title/description overlay, opens the browser's print dialog, and fully restores the normal editor on cancel or on returning from print preview.
- The dark mode preference applies instantly, persists across navigation and a full page reload with no flash of the other theme, and requires no sign-in — it works identically on the public landing/blueprints pages and the authenticated app.

## Where To Observe State

- **Worker logs:** Workers & Pages > `architect` > Logs — look for `diagram_created`, `diagram_opened`, `diagram_updated`, `diagram_shared`, `diagram_share_revoked`, and `admin_diagram_deleted` entries (never graph content, tokens, or email).
- **Traces:** Workers & Pages > `architect` > Observability > Traces (10% sampling).
- **D1 data:** D1 > `architect-db` > Console; query the `users`, `diagrams`, and `diagram_shares` tables as shown above.
- **Access applications:** Zero Trust > Access controls > Applications > `architect public` and `architect app`.

Run `npm run teardown` after the presentation; see README.md for details.
