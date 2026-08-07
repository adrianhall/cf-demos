## Prerequisites

1. Deploy the demo with `npm run deploy`.
2. Open two browser windows (or a regular window plus a private one) so User A (owner) and User B (invited editor) can be shown as separate Access identities.
3. Have the Cloudflare dashboard open to the Workers & Pages and Zero Trust areas.

1. Open `https://architect.cfapps.uk` in the first window and show the public landing page without an Access challenge.
2. Select **Open the editor** and authenticate through Cloudflare Access as User A.
3. In the Diagram library, click **New diagram**, name it, choose the **API + storage** blueprint, and create it.
4. In the editor, drag or click a product from the palette onto the canvas, connect two nodes to create a labeled edge, select a node to edit its label/description in the properties panel, and delete a node.
5. Reload the browser tab and show the diagram reopens with every edit intact.
6. Return to the library (**Diagrams**), rename the diagram inline, and reopen it to confirm the rename persisted.
7. Back in the editor, click **Invite**, then **Create invitation link**, and **Copy link**.
8. In the second window, authenticate through Cloudflare Access as User B and paste the invitation link into the address bar.
9. Show the invitation page redeem, then redirect straight into the same diagram's editor — User B now sees the **Members** panel listing both identities, but no **Invite** control (only the owner sees it).
10. Back in User A's window, open **Invite** again and show the invitation has disappeared from the active list (single-use), then create a second invitation and click its revoke (trash) icon to show revocation.
11. In User B's window, try pasting the just-revoked link into the address bar and show the error state on the invitation page.
12. Click **Sign out** in either window, then show that `/app` prompts for Access authentication again.
13. In Zero Trust, open the `architect public` application and show its bypass policy.
14. Open the `architect editor` application and show the explicit `/app*` and `/api/*` destinations and authenticated-user allow policy.
15. In Workers & Pages, open the `architect` Worker and show Logs and automatic tracing are enabled; find the `diagram_created`, `diagram_invitation_created`, `invitation_redeemed`, and `diagram_invitation_revoked` log lines from the steps above.
16. Open D1 and show the `diagram_members` row added for User B, and the `diagram_invites` row for the revoked invitation (`revoked_at` set, `token_digest` populated but never the raw token). Open Durable Objects and show the `DiagramRoom` namespace with a live instance for the shared diagram.
17. Open R2 and Workers KV and show they remain empty — Phase 3 does not publish or generate AI proposals yet.

Expected result: public pages remain reachable without a JWT; application pages and APIs require Cloudflare Access. The diagram's owner can create a single-use, expiring invitation link and revoke it; a second identity can redeem an active link into durable editor membership and immediately list, open, and edit the same diagram; a revoked or already-used link is rejected with a clear error. No live cursors, AI proposals, or public-publishing state exists yet.
