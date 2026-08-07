## Prerequisites

1. Deploy the demo with `npm run deploy`.
2. Open a private browser window so the public and authenticated flows can be shown separately.
3. Have the Cloudflare dashboard open to the Workers & Pages and Zero Trust areas.

1. Open `https://architect.cfapps.uk` in the private window and show the public landing page without an Access challenge.
2. Select **Open the editor** and authenticate through Cloudflare Access.
3. Show the empty Diagram library shell and the verified identity returned by its `GET /api/me` request.
4. Click **Sign out**, then show that `/app` prompts for Access authentication again.
5. In Zero Trust, open the `architect public` application and show its bypass policy.
6. Open the `architect editor` application and show the explicit `/app*` and `/api/*` destinations and authenticated-user allow policy.
7. In Workers & Pages, open the `architect` Worker and show Logs and automatic tracing are enabled.
8. Open D1, R2, and Workers KV and show the empty `architect-db`, `architect-snapshots`, and `architect-shares` resources prepared for the next phases.
9. Open Durable Objects and Workflows to show the registered `DiagramRoom` namespace and `architect-architecture` Workflow definition.

Expected result: public pages remain reachable without a JWT; application pages and APIs require Cloudflare Access. No diagram state or AI job exists in Phase 1.
