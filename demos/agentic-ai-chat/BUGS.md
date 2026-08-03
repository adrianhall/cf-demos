# Bugs Found And Fixed

Real bugs reported while testing this demo's deployed Phase 3 (Chat Sidebar And Management,
US-2), logged here with their symptom, root cause, and fix. Both are **fixed** in this
checkout. Full investigation detail, live timing evidence, and the regression tests that lock
each fix in place live in [`docs/DECISIONS.md`](../../docs/DECISIONS.md) items 20 and 21; this
file is the short-form index.

## 1. Sidebar title stayed "New chat" until an unrelated page reload — FIXED

**Symptom:** Typing a message into a new chat streamed a response correctly, but the sidebar
entry kept showing "New chat" instead of the generated title. Reloading the page immediately
showed the correct title.

**Root cause:** The sidebar's refresh logic watched the turn's own `isStreaming` status to
decide when to reload the chat directory. But the AI SDK's `toUIMessageStreamResponse()`
enqueues the client-visible `{"type":"finish"}` part — the signal that flips `isStreaming` back
to `false` — as soon as the model itself finishes generating, with no dependency on whether
`ChatAgent`'s own `onFinish` side effects (a D1 recency-touch write, and a second, non-streaming
`env.AI` call generating the chat's title) have resolved. Confirmed live with a timestamped
diagnostic: the client saw "finish" at 104ms, while the title write didn't land until 607ms. The
sidebar reloaded on the earlier signal and reliably saw the *previous* title.

**Fix:** `ChatAgent.afterTurnCompleted()` now broadcasts an explicit `chat_metadata_updated`
frame once its own D1 writes are actually done (success, failure, or a skipped title generation
all still broadcast). The client's `useChatAgent` composable exposes this as a
`metadataUpdatedAt` timestamp; the sidebar now reloads off that signal instead of `isStreaming`.

- Root cause and fix: `docs/DECISIONS.md` #20
- Regression test: `tests/integration/chat-management.test.ts` — "broadcasts
  `chat_metadata_updated` only once the generated title has actually landed in D1"

## 2. Deleting a chat failed with "An unexpected error occurred" and left it undeleted — FIXED

**Symptom:** Creating a second chat and immediately deleting it produced "An unexpected error
occurred," the chat was not removed from the sidebar, and reopening it showed an empty
transcript ("No messages yet") as if some of its state had already been wiped anyway.

**Root cause:** `DELETE /api/chats/:id` called `await stub.destroy()` with no error handling.
The Agents SDK's base `Agent.destroy()` defers its own `ctx.abort()` behind a
`setTimeout(..., 0)` specifically so its RPC caller receives a clean, resolved response before
that abort runs — but that guarantee is not airtight. Reproduced directly by patching
`ChatAgent.prototype.destroy` to throw: the rejection aborted the whole route *before* the D1
directory row was ever removed, while the Durable Object's own storage had typically already
been wiped by whatever `destroy()` did manage to execute — producing every observed symptom at
once.

**Fix:** `stub.destroy()` is now wrapped in its own `try`/`catch` (logging
`chat_destroy_failed`), and the route unconditionally proceeds to remove the D1 row regardless
of whether that RPC call resolved or rejected. A rejected `destroy()` call no longer means
"deletion failed" — the directory entry, the thing this route actually promises to remove, is
gone either way.

- Root cause and fix: `docs/DECISIONS.md` #21
- Regression test: `tests/integration/chat-management.test.ts` — "still removes the D1 row and
  returns 204 when the Durable Object's own destroy() RPC call rejects"
