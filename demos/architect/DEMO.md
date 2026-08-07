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
17. Open R2 and Workers KV and show they remain empty — this demo does not publish or generate AI proposals yet.

Expected result: public pages remain reachable without a JWT; application pages and APIs require Cloudflare Access. The diagram's owner can create a single-use, expiring invitation link and revoke it; a second identity can redeem an active link into durable editor membership and immediately list, open, and edit the same diagram; a revoked or already-used link is rejected with a clear error.

## Live cooperative editing (both windows open together)

18. With User A and User B both still authenticated from the steps above, have each open the same diagram's editor at the same time — User A can reopen it from the library; User B can reopen it from the link **Diagrams** takes them to, since redemption already granted membership.
19. In each window's toolbar, point out the connection chip (`connected`, with a Wi-Fi icon) and the other participant's email chip next to it.
20. Move the mouse over User A's canvas without clicking anything and show User B's window rendering a labeled, live-updating cursor marker at the matching graph position — then do the same in the other direction.
21. In User A's window, drag a node to a new position and drop it; show the node moving in User B's window within roughly a second, with no manual refresh.
22. In User B's window, click a node to select it and edit its label in the properties panel; show the updated label appear in User A's window.
23. Demonstrate a resolved conflict: in both windows, select the *same* node's properties panel at once, and submit a label edit from each window as close together as possible. One window's edit applies immediately; the other briefly shows the "Your edit conflicted…" warning banner (and the same sentence read aloud by a screen reader from the toolbar's live region) with the diagram already refreshed to the winning value — retry the edit in that window to show it now applies normally.
24. Close User B's browser tab entirely (not just navigate away) and show User A's window losing the participant chip and cursor marker within a few seconds.
25. In Workers & Pages, open the `architect` Worker's Logs and find the `participant_joined`, `operation_accepted`, and `participant_left` structured log lines from the steps above — point out that none of them include the diagram's actual graph content or cursor coordinates.
26. Open the Durable Objects view and show the `DiagramRoom` instance's active WebSocket connections while both windows are still open.

Expected result: two authenticated editors see each other's presence and live cursor exactly as they move, both windows converge on the same accepted revision after concurrent edits, a losing edit is never silently merged and requires an explicit retry, and closing a tab promptly updates the remaining window's participant list.
