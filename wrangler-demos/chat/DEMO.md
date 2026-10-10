# Chat Demo Script

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches.

## Demonstration Prerequisites

1. Deploy the demo with `npm run deploy` from `demos/chat`.
2. Have two identities ready to sign in as (any two accounts recognized by the deployed Access identity provider), and two browser windows/profiles so both sessions stay signed in simultaneously — for example one normal window and one private/incognito window.
3. Open a second browser tab to the Cloudflare dashboard at **Workers & Pages** > `chat` > **Logs**.

## Presentation Flow

1. Open `https://chat.cfapps.uk` in both windows and sign in as two different identities — User A and User B. Point out that Access gates the entire hostname; there is no anonymous route, unlike the mixed public/admin demos.
2. In both windows, select the seeded `general` channel from the sidebar.
3. Post a message as User A. Show it appearing **immediately in both windows**, labeled with User A's identity.
4. Post a reply as User B and watch it appear in both windows.
5. As User A, add a new channel (for example `deploys`) using the sidebar's add-channel control. Point out it appears in User B's channel list too, since the directory is shared in D1.
6. Switch one window to `deploys` and post a message there. Confirm it never appears in `general` — a different channel name routes to a different Durable Object, so channels are isolated by construction.
7. Close User B's browser window entirely, then reopen it, sign back in, and rejoin `general`. Confirm the **recent history replays** immediately — User B recovers the authoritative conversation from the channel's Durable Object storage, not an empty room.
8. As either user, remove the `deploys` channel from the sidebar. Confirm it disappears from both channel lists, any window still viewing it is dropped with a clear removal notice and moved to a remaining channel, and its Durable Object state is gone — rejoining a channel by that name later starts empty.
9. Switch to the dashboard tab and open Workers Logs. Locate the `channel_created` event from step 5, the `channel_joined` events from steps 2 and 7, the `message_posted` events from steps 3, 4, and 6, the `channel_left` events from step 7's disconnect, and the `channel_removed` event from step 8.

## Expected Results

- Unauthenticated navigation and unauthenticated `/api/*`/WebSocket-upgrade requests are rejected by Access before reaching application logic.
- Two signed-in identities see each other's messages in the same channel in real time.
- A message posted in one channel never appears in another channel's message pane.
- Removing a channel disconnects every socket connected to it with a visible notice and leaves no Durable Object state or D1 directory row behind.
- A disconnect/reconnect (including closing and reopening the browser window) recovers the full recent history rather than starting from an empty room.
- Every demonstrated action produces its matching informational log event.

## Where To Observe State

- **Worker logs:** Workers & Pages > `chat` > Logs; filter for `channel_created`, `channel_removed`, `channel_joined`, `message_posted`, or `channel_left`.
- **Traces:** Workers & Pages > `chat` > Observability > Traces (10% sampling).
- **Durable Objects:** Workers & Pages > `chat` > Durable Objects > `CHAT_ROOM`; each live channel appears as its own named instance.
- **D1 data:** D1 > `chat-db` > Console; `SELECT name, created_by, created_at FROM channels ORDER BY name;` shows the shared directory — message history is deliberately not here.
- **Access application:** Zero Trust > Access controls > Applications > `chat`.

Run `npm run teardown` after the presentation; see README.md for details.
