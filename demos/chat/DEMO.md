# Enterprise Chat Demo Guide

## Purpose

This demo shows a channel-based chat workspace where every signed-in user shares a live
conversation. It is the curriculum's introduction to **Durable Objects** and **hibernatable
WebSockets**: routing to one coordination atom per channel, broadcasting to every participant of
that atom, and recovering authoritative room state from the Durable Object's own SQLite storage
after a client reconnects. Workers, Static Assets, and Cloudflare Access are reused from earlier
demos, and D1 (from Demo 2) is reused only to hold the small, shared channel directory.

## Cloudflare Capabilities

- **Durable Objects** as the coordination atom for a chat channel: one `ChatRoom` instance per
  channel name, addressed with `env.CHAT_ROOM.getByName(name)`, holding the channel's
  authoritative message history and broadcasting to every connected participant. Different
  channel names always route to different Durable Objects, so channels are isolated from one
  another by construction.
- **Hibernatable WebSockets** (`ctx.acceptWebSocket`): an idle channel consumes no Duration while
  its connections and state are preserved, and a reconnecting client recovers recent history from
  the Durable Object's own SQLite storage rather than an empty room.
- **Cloudflare Access** providing every request's verified user identity — including on the
  WebSocket upgrade — with no separate login system and no way for a client to spoof another
  participant's identity.
- **D1** as the small, shared channel directory, kept deliberately separate from the
  Durable-Object-owned message history.
- **Workers Logs** showing structured `channel_created`, `channel_removed`, `channel_joined`,
  `message_posted`, and `channel_left` events for real, authorized activity.

## Demonstration Prerequisites

1. Deploy from `demos/chat` with `npm run deploy`.
2. Have two browser identities ready to sign in as (any two accounts recognized by the deployed
   Access identity provider), or use two browser windows/profiles so both sessions stay signed in
   simultaneously (for example one normal window and one private/incognito window).
3. Open **Workers & Pages → chat → Logs** in a separate browser tab.
4. Optionally open **Workers & Pages → chat → Durable Objects** in the dashboard to point out the
   `CHAT_ROOM` namespace during the routing-isolation step.

## Presentation Flow

1. Open `https://chat.cfapps.uk` in two windows and sign in as two different identities — User A
   and User B. Point out that Access gates the entire hostname; there is no anonymous route.
2. In both windows, select the seeded `general` channel from the sidebar.
3. Post a message as User A. It appears **immediately in both windows**, labeled with User A's
   identity — the channel's `ChatRoom` Durable Object broadcast it to every connected socket.
4. Post a reply as User B and watch it appear in both windows.
5. As User A, add a new channel (for example `deploys`) using the sidebar's add-channel field.
   Point out it appears in User B's channel list too, since the directory is shared in D1. Switch
   one window to `deploys` and post a message there; confirm it never appears in `general` —
   a different channel name routed to a different Durable Object.
6. Close User B's browser window entirely, then reopen it and sign back in and rejoin `general`.
   Confirm the **recent history replays** immediately — User B recovers the authoritative
   conversation from the channel's Durable Object storage, not an empty room.
7. As either user, remove the `deploys` channel from the sidebar. Confirm it disappears from both
   channel lists, any window still viewing it is dropped with a clear removal notice and moved to
   a remaining channel, and its Durable Object state is gone — rejoining a channel by that name
   later starts empty.
8. Open Workers Logs and locate the `channel_created`, `channel_removed`, `channel_joined`,
   `message_posted`, and `channel_left` events, correlated by channel name.

## Expected Results

- Unauthenticated navigation and unauthenticated `/api/*`/WebSocket-upgrade requests are
  rejected by Access before reaching application logic.
- Two signed-in identities see each other's messages in the same channel in real time.
- A message posted in one channel never appears in another channel's message pane.
- Removing a channel disconnects every socket connected to it with a visible notice and leaves no
  Durable Object state or D1 directory row behind.
- A disconnect/reconnect (including closing and reopening the browser window) recovers the full
  recent history rather than starting from an empty room.
- Every demonstrated action produces its matching informational log event.

## Where To Observe State

- **Worker logs:** Workers & Pages → `chat` → Logs; filter for a channel or message event.
- **Traces:** Workers & Pages → `chat` → Observability → Traces; sampling is 10%.
- **Durable Objects:** Workers & Pages → `chat` → Durable Objects → `CHAT_ROOM`; each live
  channel appears as its own named instance.
- **D1 data:** D1 → `chat-db` → Console; `SELECT name, created_by, created_at FROM channels
  ORDER BY name;` shows the shared directory (message history is deliberately not here).
- **Access application:** Zero Trust → Access controls → Applications → `chat`.

## Local Demonstration

Run `npm start` and open the local Vite address. The development-only Access plugin offers
`alice@example.com` and `bob@example.com` — enough to run the full two-user flow above from one
machine using two browser windows. Local D1 and Durable Object state live in `.wrangler/` and
never touch deployed resources.

## Cleanup

Run `npm run teardown` from `demos/chat` after the presentation. It removes the Access
application and policy, custom domain, Worker, and D1 database; the `CHAT_ROOM` Durable Object
namespace and all channel state are removed along with the Worker.
