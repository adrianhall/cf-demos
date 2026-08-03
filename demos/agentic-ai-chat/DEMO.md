# Agentic Chat Demo Script

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches. This checkout implements Phase 1 (Scaffolding), Phase 2 (Core Agentic Chat, US-1), and Phase 3 (Chat Sidebar And Management, US-2) — the authenticated shell, the D1 user directory, a real, streamed, multi-turn conversation with a Durable Object-backed `ChatAgent`, and a sidebar for creating, switching between, auto-titling, and deleting chats. Later phases' demo scripts pick up from here for model routing, cost tracking, tools, skills, and the admin console.

## Demonstration Prerequisites

1. Deploy the demo with `npm run deploy` from `demos/agentic-ai-chat`.
2. Confirm you can authenticate through the configured identity provider as at least two different identities: one matching this deployment's `ADMIN_EMAIL`, and one that does not.
3. Open a second browser window or tab to the Cloudflare dashboard at **Zero Trust** > **Access controls** > **Applications**.
4. Open a third browser window or tab to the Cloudflare dashboard's **D1** section, ready to open the `agentic-chat-db` database's console.
5. Open a fourth browser window or tab to the Cloudflare dashboard's **AI Gateway** section, ready to open the `agentic-chat` gateway's request log.
6. Sign out of, or use a private/incognito window for, the demo hostname so the first step shows the unauthenticated experience.

## Presentation Flow

1. In the signed-out/incognito browser, open `https://agentic-chat.cfapps.uk/`. Show that Cloudflare Access intercepts the request with its login screen before any part of the app renders.
2. Switch to the dashboard tab. Open **Zero Trust** > **Access controls** > **Applications** and show the single application for this demo, covering the whole hostname with an allow policy that requires authentication from any identity in the configured provider — no public bypass — and note its Audience tag, matched by `VITE_ACCESS_AUDIENCE` in the deployed Worker.
3. Back in the browser, sign in as the identity matching `ADMIN_EMAIL`.
4. Point out the header: the signed-in email and an **Administrator** badge, sourced from `GET /api/me`'s D1-backed `isAdmin` flag, not from Cloudflare Access itself. Point out the sidebar on the left, currently showing its empty state.
5. Click **+ New Chat**. Point out it appears in the sidebar immediately, labeled "New chat" until it has any content.
6. Type a message in the composer (for example "In one sentence, what is Cloudflare Workers?") and press Enter. Point out:
   - The activity indicator while waiting for the first token.
   - The response streaming in token by token, not appearing all at once.
   - Shortly after the response finishes, the sidebar entry's label updates from "New chat" to a short, model-generated title summarizing the exchange.
7. Switch to the D1 tab. Open the `agentic-chat-db` database's console and run:

   ```sql
   SELECT id, owner_email, title, created_at, updated_at FROM chats ORDER BY updated_at DESC;
   ```

   Point out the new row: one D1 directory entry per chat, owned by the signed-in identity, now carrying the generated title and a bumped `updated_at`.
8. Switch to the AI Gateway tab. Refresh the `agentic-chat` gateway's request log and point out **two** requests from this turn: the chat turn itself, and the second, smaller title-generation call — both attributed to the same gateway later phases reuse for governed routing and cost tracking.
9. Back in the browser, send a second message in the same chat referencing the first (for example "Can you say that more simply?") and point out the response reflects the earlier turn, and that the chat's title did **not** change — it is only ever generated once.
10. Click **+ New Chat** again. Point out this starts a second, entirely separate conversation, and the sidebar now lists two chats, most recently active first.
11. Send a message in this second chat, then click back to the first chat in the sidebar and point out its own history reloads correctly — each chat is its own `ChatAgent` Durable Object, not a shared conversation.
12. **Reload the page.** Point out the same chat list and the currently open conversation reappear exactly as they were — loaded from D1 (the directory) and the `ChatAgent` Durable Object's own durable storage (the content), not replayed from anything kept in browser memory.
13. Open a second browser tab to the same hostname, signed in as the same identity, and open the same chat that is open in the first tab. In the first tab, delete that chat from the sidebar. Point out the second tab is notified immediately (its view moves off the deleted chat) rather than being left silently connected to a chat that no longer exists.
14. Back in the dashboard, open **Workers & Pages** > `agentic-chat` > **Logs** and show the `chat_created`, `chat_connected`, and `chat_deleted` log entries from this session.
15. Optionally, open **Durable Objects** in the dashboard (under **Workers & Pages** > `agentic-chat` > **Bindings**, or the account-level Durable Objects view) and show the `ChatAgent` class with one live instance per remaining chat — the coordination atom for each conversation.
16. Back in the browser, use the always-visible **Sign out** control.
17. Sign in as the second, non-administrator identity and click **+ New Chat**. Point out this identity sees an empty sidebar of its own — chats are never shared across identities.
18. Re-run the D1 query from step 7 and show every identity's chats coexisting in the same table, each still visible only to its own owner through the app.

## Expected Results

- Unauthenticated visitors to the hostname see the Cloudflare Access login screen, never the app; an unauthenticated `GET /api/me` receives `401`.
- Every sign-in upserts a `users` row; only the identity matching `ADMIN_EMAIL` ever has `is_admin = 1`, regardless of sign-in order.
- A submitted prompt streams a response incrementally, with visible progress before the first token.
- A second prompt in the same chat has access to the first turn's context.
- A chat acquires a short generated title after its first exchange, and never again after that.
- "+ New Chat" and the sidebar let a signed-in user manage more than one conversation, each fully isolated from every other identity's chats.
- Deleting the open chat from another connected tab/device is reflected immediately, not left as a silently dead connection.
- Reloading the page resumes the same chat list and conversation from durable storage.

## Where To Observe State

- **Worker logs:** Workers & Pages > `agentic-chat` > Logs (`chat_created`, `chat_connected`, `chat_deleted` entries).
- **Traces:** Workers & Pages > `agentic-chat` > Observability > Traces (10% sampling).
- **D1 data:** D1 > `agentic-chat-db` > Console; query the `chats`/`users` tables as shown above.
- **Access application:** Zero Trust > Access controls > Applications > `agentic-chat`.
- **AI Gateway:** AI Gateway > `agentic-chat` — every chat turn's request log entry (including the auto-title generation calls), model, latency, and cost.
- **Durable Objects:** the `ChatAgent` class and its live instances, one per chat.

Run `npm run teardown` after the presentation; see README.md for details.
