## Prerequisites

1. Deploy the demo with `npm run deploy`.
2. Open a private browser window so the public and authenticated flows can be shown separately.
3. Have the Cloudflare dashboard open to the Workers & Pages and Zero Trust areas.

1. Open `https://architect.cfapps.uk` in the private window and show the public landing page without an Access challenge.
2. Select **Open the editor** and authenticate through Cloudflare Access.
3. In the Diagram library, click **New diagram**, name it, choose the **API + storage** blueprint, and create it.
4. In the editor, drag or click a product from the palette onto the canvas, connect two nodes to create a labeled edge, select a node to edit its label/description in the properties panel, and delete a node.
5. Reload the browser tab and show the diagram reopens with every edit intact.
6. Return to the library (**Diagrams**), rename the diagram inline, and reopen it to confirm the rename persisted.
7. Click **Sign out**, then show that `/app` prompts for Access authentication again.
8. In Zero Trust, open the `architect public` application and show its bypass policy.
9. Open the `architect editor` application and show the explicit `/app*` and `/api/*` destinations and authenticated-user allow policy.
10. In Workers & Pages, open the `architect` Worker and show Logs and automatic tracing are enabled; find the `diagram_created`, `diagram_opened`, and `diagram_updated` log lines from the steps above.
11. Open D1 and show the `diagrams` and `diagram_members` rows created above. Open Durable Objects and show the `DiagramRoom` namespace with a live instance for the created diagram.
12. Open R2 and Workers KV and show they remain empty — Phase 2 does not publish or generate AI proposals yet.

Expected result: public pages remain reachable without a JWT; application pages and APIs require Cloudflare Access. One authenticated user can create, edit, reload, rename, and reopen a durable diagram entirely through `DiagramRoom`'s revisioned document API. No collaboration, invitation, AI proposal, or public-publishing state exists yet.
