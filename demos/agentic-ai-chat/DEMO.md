# Agentic Chat Demo Script

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches. This checkout implements Phase 1 (Scaffolding) through Phase 9 (Tool — Write A File To My Chat, US-8) — the authenticated shell, the D1 user directory, a real, streamed, multi-turn conversation with a Durable Object-backed `ChatAgent`, a sidebar for creating, switching between, auto-titling, and deleting chats, a "Basic"/"Reasoning" mode selector backed by governed AI Gateway dynamic routes rather than a client-visible model id, a microphone control that dictates a prompt via Workers AI speech-to-text, a per-chat cost/token readout that starts **Estimated** and upgrades in place to **AI Gateway**-confirmed once AI Gateway's own logged figures for that turn are found, an Admin Console ranking every user by total cost, editing any user's business/geo segment, and reporting cost by business and by geo, each route's own conditional/rate-limit logic steering the caller's business segment to a different underlying model with zero client-side branching, and a `writeMarkdown` tool that lets the agent save a real, downloadable file to R2, attached to the chat and visible only to its owner. Later phases' demo scripts pick up from here for a second tool (safe URL fetching) and skills.

## Demonstration Prerequisites

1. Deploy the demo with `npm run deploy` from `demos/agentic-ai-chat`.
2. Confirm you can authenticate through the configured identity provider as at least two different identities: one matching this deployment's `ADMIN_EMAIL`, and one that does not.
3. Open a second browser window or tab to the Cloudflare dashboard at **Zero Trust** > **Access controls** > **Applications**.
4. Open a third browser window or tab to the Cloudflare dashboard's **D1** section, ready to open the `agentic-chat-db` database's console.
5. Open a fourth browser window or tab to the Cloudflare dashboard's **AI Gateway** section, ready to open the `agentic-chat` gateway and its two dynamic routes (**basic**, **reasoning**), and its overall request log.
6. Open a fifth browser window or tab to the Cloudflare dashboard's **R2** section, ready to open the `agentic-chat-files` bucket.
7. Sign out of, or use a private/incognito window for, the demo hostname so the first step shows the unauthenticated experience.
8. Use a browser with a working microphone, and be prepared to grant microphone permission when prompted.
9. Sign in as the non-administrator identity from step 2 at least once before starting the walkthrough below (opening the app and letting `GET /api/me` upsert its `users` row is enough), so it already appears in the Admin Console's ranked table when this script reaches it.

## Presentation Flow

1. In the signed-out/incognito browser, open `https://agentic-chat.cfapps.uk/`. Show that Cloudflare Access intercepts the request with its login screen before any part of the app renders.
2. Switch to the dashboard tab. Open **Zero Trust** > **Access controls** > **Applications** and show the single application for this demo, covering the whole hostname with an allow policy that requires authentication from any identity in the configured provider — no public bypass — and note its Audience tag, matched by `VITE_ACCESS_AUDIENCE` in the deployed Worker.
3. Back in the browser, sign in as the identity matching `ADMIN_EMAIL`.
4. Point out the header: the signed-in email and an **Administrator** badge, sourced from `GET /api/me`'s D1-backed `isAdmin` flag, not from Cloudflare Access itself. Point out the sidebar on the left, currently showing its empty state.
5. Click **+ New Chat**. Point out it appears in the sidebar immediately, labeled "New chat" until it has any content, and point out the "Mode" dropdown above the composer, already showing **Basic** and enabled (no turns yet).
6. Type a message in the composer (for example "In one sentence, what is Cloudflare Workers?") and press Enter. Point out:
   - The "Mode" dropdown becomes disabled the instant the message is submitted — a chat's mode locks in once it has a turn.
   - The activity indicator while waiting for the first token.
   - The response streaming in token by token, not appearing all at once.
   - Shortly after the response finishes, the sidebar entry's label updates from "New chat" to a short, model-generated title summarizing the exchange.
7. Point out the chat header now shows a cost/token readout next to the "Mode" dropdown, currently labeled **Estimated** — this demo's own immediately-available pricing-table guess, computed the moment the turn finished, before AI Gateway's own logged figure is available.
8. Wait roughly 10–40 seconds (or reload the page to observe the pushed update immediately), then point out the same readout flips to **AI Gateway**, now paired with a "1 of 1 turn confirmed by AI Gateway" ratio — and that the sidebar entry for this same chat shows a matching cost figure of its own, with the same badge language.
9. Switch to the D1 tab. Open the `agentic-chat-db` database's console and run:

   ```sql
   SELECT id, owner_email, title, route, created_at, updated_at FROM chats ORDER BY updated_at DESC;
   ```

   Point out the new row: one D1 directory entry per chat, owned by the signed-in identity, now carrying the generated title, its `route` (`basic`), and a bumped `updated_at`. Then run `SELECT chat_id, model, cost_source, cost_usd, prompt_tokens, completion_tokens, gateway_log_id FROM chat_usage ORDER BY created_at DESC;` and point out this turn's own row — by now `cost_source = 'gateway'` with a real `gateway_log_id`, matching what step 7's readout already showed in the browser.
10. Switch to the AI Gateway tab. Open the **basic** dynamic route's request log and point out **two** requests from this turn: the chat turn itself, and the second, smaller title-generation call — both resolved through this route, not a hard-coded model.
11. Back in the browser, send a second message in the same chat referencing the first (for example "Can you say that more simply?") and point out the response reflects the earlier turn, and that the chat's title did **not** change — it is only ever generated once.
12. Click the microphone control on the composer. Grant microphone access when prompted, point out the control's own visual state changes (requesting access, then recording), dictate a short question (for example "What is the capital of France?"), then click the control again to stop. Point out:
    - The control briefly shows a transcribing state before the text appears.
    - The transcribed text populates the composer editable and **not submitted** — press Enter (or edit the text first) to actually send it.
13. Switch to the AI Gateway tab and open its overall request log (not a specific dynamic route — dictation calls the model directly, not through either "Basic"/"Reasoning" route). Point out the `@cf/openai/whisper-large-v3-turbo` request from step 12.
14. Click **+ New Chat** again. Before typing anything, change its "Mode" dropdown to **Reasoning** and point out the dropdown is still enabled at this point (no turn yet). Send a message (for example "Explain, step by step, why the sky is blue.") and point out the response still streams normally.
15. Switch to the AI Gateway tab and open the **reasoning** dynamic route's request log instead of **basic**'s. Point out this turn's request appears here, resolved to a different, reasoning-capable model than the first chat's turns — the same "Mode" selector, two different governed routes, two different models, with no client-side difference in what the browser itself sent beyond the literal word "reasoning".
16. Back in the browser, click back to the first chat in the sidebar and point out its own history and "Basic" mode still load correctly — each chat is its own `ChatAgent` Durable Object with its own persisted route, not a shared conversation or a shared setting.
17. Attempt to change the first chat's "Mode" dropdown. Point out it remains disabled: a chat's route can only be changed before its first turn completes.
18. **Reload the page.** Point out the same chat list and the currently open conversation — including each chat's own mode — reappear exactly as they were, loaded from D1 (the directory) and the `ChatAgent` Durable Object's own durable storage (the content), not replayed from anything kept in browser memory.
19. Open a second browser tab to the same hostname, signed in as the same identity, and open the same chat that is open in the first tab. In the first tab, delete that chat from the sidebar. Point out the second tab is notified immediately (its view moves off the deleted chat) rather than being left silently connected to a chat that no longer exists.
20. Back in the dashboard, open **Workers & Pages** > `agentic-chat` > **Logs** and show the `chat_created`, `chat_connected`, `chat_deleted`, and `transcription_completed` log entries from this session.
21. Optionally, open **Durable Objects** in the dashboard (under **Workers & Pages** > `agentic-chat` > **Bindings**, or the account-level Durable Objects view) and show the `ChatAgent` class with one live instance per remaining chat — the coordination atom for each conversation.
22. Still signed in as the administrator, point out the **Admin console** link in the header. Click it.
23. Point out the ranked "Users by cost" table: your own identity (and the non-administrator identity from step 9 of Demonstration Prerequisites, already listed with a zeroed cost) both appear, ordered by total cost descending.
24. In your own row, change **Business** to **Leadership** and **Geo** to **Americas**. Point out the row updates immediately, with no page reload.
25. Point out the "Cost by business" and "Cost by geo" sections below now show a "Leadership"/"Americas" row matching your own cost figure from the table above.
26. Switch to the D1 tab and run `SELECT email, is_admin, business, geo FROM users;`. Point out your own row's `business`/`geo` columns now hold the values just set from the browser.
27. Back in the browser, use the always-visible **Sign out** control, then sign in as the second, non-administrator identity. Point out no **Admin console** link appears in the header for this identity, then click **+ New Chat** and point out this identity sees an empty sidebar of its own — chats are never shared across identities.
28. Attempt to navigate directly to `https://agentic-chat.cfapps.uk/admin` as this identity. Point out the page itself loads (Cloudflare Access does not block it — there is only one Access application on this hostname) but every section shows an error message instead of a table, since `requireAdmin()` rejects the underlying `/api/admin/*` requests with `403`.
29. Re-run the D1 queries from step 9 and show every identity's chats and `chat_usage` rows coexisting in the same tables, each still visible only to its own owner through the app.
30. Still signed in as the administrator, in the same Admin Console, confirm your own **Business** is currently **Leadership** (set in step 24). Open the chat from step 5 (or any existing "Basic" mode chat) and send another message. Switch to the AI Gateway tab, open the **basic** dynamic route's request log, and point out this newest request resolved to a different, stronger model than every earlier request in this same route's log — purely because your identity's business segment is "Leadership", with no change at all to what the browser sent (still just "Basic" mode).
31. Back in the browser, return to the Admin Console and change your own **Business** to **Field**. Go back to the **same chat** from step 30 (not a new one) and send one more message. Switch to the AI Gateway tab and point out this newest request in the **basic** route's log resolved back to the original, cheaper model — the exact same chat, the exact same "Basic" mode, a different model purely because your business segment changed between turns, re-read fresh from D1 on every request with no redeploy and no cache to invalidate.
32. Still in the AI Gateway tab, open the **basic** dynamic route's own configuration view (not just its log) and point out the `business-check` conditional element, the `basic-rate-gate` rate-limit element beneath its "false" branch (scoped per business value, `key = metadata.business`), and the two model elements it can resolve to — the same shape visible in the **reasoning** route.
33. Open the gateway's own settings and point out its **Spend limits** section: a $1/day cost budget, partitioned by the `business` metadata dimension, so each business segment gets its own independent budget pool rather than sharing one account-wide pool.
34. Open (or return to) any chat and type "Please save a three-item packing list for a beach trip as a Markdown file." Point out:
    - The response streams in as normal.
    - Once it finishes, an attachment chip appears below the assistant's text, showing a generated filename ending in `.md`.
35. Click the attachment chip. Point out it downloads a real Markdown file whose content is the packing list the assistant just described.
36. Switch to the R2 tab, open the `agentic-chat-files` bucket, and point out an object under a `chats/<chat-id>/files/` prefix matching the chat from step 34 — the file the chip downloaded, stored for real, not just rendered from the transcript's own text.
37. Switch to the D1 tab and run `SELECT chat_id, filename, size_bytes, correlation_id, created_at FROM chat_files ORDER BY created_at DESC;`. Point out the new row, its `filename` matching the chip, and that no route exposes this table directly — only `GET /api/chats/:id/files/:fileId` (step 35) ever reads it. Then run `SELECT correlation_id, cost_source, cost_usd FROM chat_usage WHERE correlation_id = '<the file row's correlation_id>';` and point out it returns the exact turn that produced the file — the same per-turn correlation id both tables share, an exact join key rather than one inferred from timestamps.
38. Open a private/incognito window, sign in as the non-administrator identity, and attempt to open the exact same file URL from step 35 (copy it from the browser's address bar after step 35, or the network tab). Point out it returns an error, not the file — this identity does not own the chat that file belongs to, and the tool's write path never grants R2 access to anyone but this Worker's own routes.
39. Back in the original browser, ask the agent to save another file with no content ("Please save an empty file with no text in it") — a request the tool's own validation rejects. Point out the assistant explains it could not save an empty document, rather than the turn failing outright, and that no new attachment chip or R2/D1 row appears for this attempt.

## Expected Results

- Unauthenticated visitors to the hostname see the Cloudflare Access login screen, never the app; an unauthenticated `GET /api/me` receives `401`.
- Every sign-in upserts a `users` row; only the identity matching `ADMIN_EMAIL` ever has `is_admin = 1`, regardless of sign-in order.
- A submitted prompt streams a response incrementally, with visible progress before the first token.
- A second prompt in the same chat has access to the first turn's context.
- A chat acquires a short generated title after its first exchange, and never again after that.
- "+ New Chat" and the sidebar let a signed-in user manage more than one conversation, each fully isolated from every other identity's chats.
- The "Mode" dropdown offers exactly "Basic"/"Reasoning", defaults to "Basic," and locks once a chat has its first turn.
- Two chats with different modes resolve to two different AI Gateway dynamic routes, and (per each route's currently configured model) two different underlying models — verified from the AI Gateway request logs, not just the app's own response text.
- Deleting the open chat from another connected tab/device is reflected immediately, not left as a silently dead connection.
- Reloading the page resumes the same chat list, conversations, and their own modes from durable storage.
- Dictating a prompt produces editable composer text, never an auto-submitted message, backed by a real `@cf/openai/whisper-large-v3-turbo` call visible in the AI Gateway request log.
- A completed turn's cost/token readout is visible immediately (labeled **Estimated**) and upgrades in place to **AI Gateway**-confirmed figures within roughly 10–40 seconds, without a page reload, in both the chat header and the sidebar.
- The **Admin console** link appears only for the identity matching `ADMIN_EMAIL`; a non-administrator identity never sees the link and receives `403` from every underlying `/api/admin/*` request if it navigates to `/admin` directly.
- The ranked "Users by cost" table lists every signed-in identity, highest cost first; editing a user's business/geo segment updates that row immediately and is reflected in both segment reports without a page reload.
- The same "Basic"/"Reasoning" mode selection resolves to a different underlying model depending on the caller's business segment (verified from the AI Gateway request log), including within the same chat across two turns whose caller's business segment changed in between — with zero difference in what the browser itself sent.
- Asking the agent to produce a document reliably yields a real, downloadable file, attached to the chat as an inline attachment chip, visible only to that chat's owner.
- Asking the agent to save invalid content (no text) is refused with a clear explanation in the assistant's reply, not a failed or silently truncated turn.

## Where To Observe State

- **Worker logs:** Workers & Pages > `agentic-chat` > Logs (`chat_created`, `chat_connected`, `chat_route_changed`, `chat_deleted`, `transcription_completed`, `admin_user_metadata_updated`, `chat_file_downloaded` entries).
- **Traces:** Workers & Pages > `agentic-chat` > Observability > Traces (10% sampling).
- **D1 data:** D1 > `agentic-chat-db` > Console; query the `chats`/`users` tables as shown above (`route` is Phase 4's own column; `business`/`geo` are Phase 7's own columns), `chat_usage` (Phase 6's cost ledger — `cost_source`/`gateway_log_id` show whether a row is still estimated or already AI-Gateway-confirmed), and `chat_files` (Phase 9's agent-generated file metadata).
- **Access application:** Zero Trust > Access controls > Applications > `agentic-chat`.
- **AI Gateway:** AI Gateway > `agentic-chat` > **basic**/**reasoning** dynamic routes — each route's own request log entry (including the auto-title generation calls), resolved model, latency, and cost; each route's own `business-check` conditional/`rate-gate`/model elements (Phase 8); and the gateway's own **Spend limits** section (Phase 8, partitioned by `business`). The gateway's overall request log also shows each dictation's direct (non-routed) `@cf/openai/whisper-large-v3-turbo` call. Each request log entry's own logged cost/tokens is exactly what `chat_usage.cost_source = 'gateway'` rows are upgraded to.
- **Durable Objects:** the `ChatAgent` class and its live instances, one per chat.
- **R2 bucket:** R2 > `agentic-chat-files` — one object per file the `writeMarkdown` tool has written, under a `chats/<chat-id>/files/` prefix (Phase 9).

Run `npm run teardown` after the presentation; see README.md for details.
