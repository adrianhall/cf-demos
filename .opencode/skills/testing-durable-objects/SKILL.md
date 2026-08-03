---
name: testing-durable-objects
description: Write reliable Vitest integration tests for Durable Objects, especially ones that use hibernatable WebSockets, with @cloudflare/vitest-pool-workers. Use when writing or debugging tests for a WebSocket-based application backed by Durable Objects, when an integration test involving runInDurableObject, evictAllDurableObjects, acceptWebSocket, or ctx.storage.deleteAll() hangs or is flaky, or when a test suite's afterEach hook times out. Captures gotchas discovered building demos/chat's ChatRoom tests, logged in docs/DECISIONS.md item 8.
---

# Testing Durable Objects (especially hibernatable WebSockets)

This skill is this repo's hard-won guidance for testing Durable Objects with
`@cloudflare/vitest-pool-workers`, distilled from building `demos/chat`'s `ChatRoom`
integration tests (see `docs/04-ENTERPRISE-CHAT.md`, Phase 3, and `docs/DECISIONS.md`
item 8 for the original write-up). Every rule below was learned by hitting a real,
reproducible hang or flake in this environment — not from general-purpose advice.

**Do not treat a WebSocket/Durable-Object integration test hang as something to patch
around with a longer `testTimeout`/`hookTimeout`.** A hang here is almost always one of
the specific causes below. Find which one actually applies before reaching for a timeout
knob.

## 1. Serialize test files that open real WebSockets

`@cloudflare/vitest-pool-workers` isolates *storage* per test file but can still run
multiple files' Workers concurrently against the same local `workerd` pool. Two files
each opening hibernatable WebSockets against that shared runtime can intermittently hang
indefinitely — even though each file passes fine in isolation.

**Fix:** set `fileParallelism: false` on any integration project whose test files open
real WebSocket connections, not only ones that need shared storage. This matches
Cloudflare's own Vitest 4 migration guidance for suites that share a runtime instance.

```ts
// tests/integration/vitest.config.ts
export default defineProject(() => ({
  plugins: [cloudflareTest({ wrangler: { configPath: "..." } })],
  test: {
    name: "integration",
    include: ["**/*.test.ts"],
    // Integration test files share one real workerd runtime and its Durable Object
    // storage. Running files concurrently intermittently starves hibernatable WebSocket
    // delivery in this pool; Cloudflare's own migration guide recommends serializing
    // file execution for suites that share a runtime instance this way.
    fileParallelism: false,
  },
}));
```

The equivalent CLI-level fix is `--max-workers=1 --no-isolate`, but prefer the config
option so every invocation (local, CI) gets it automatically.

## 2. Re-create schema on every storage-erasing RPC, not just in the constructor

`ctx.storage.deleteAll()` deletes the SQLite **schema itself**, not just rows. Unless the
Durable Object instance is also evicted afterward, it keeps running with no tables, and
the very next request throws `no such table`.

**Do not rely on eviction re-running the constructor to recreate the schema** — the
timing is not guaranteed relative to the next request, in a test or in production
(for example, immediately after a client reconnects post-removal).

**Fix:** factor schema creation into a private method that the constructor *and* any
storage-erasing RPC both call, so the erasing RPC leaves the object immediately usable
again with a freshly initialized, empty store.

```ts
export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
    });
  }

  async destroy(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(CHANNEL_REMOVED_CLOSE_CODE, "Channel removed.");
    }
    await this.ctx.storage.deleteAll();
    this.initializeSchema(); // <-- not optional; the object may not be evicted next
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }
}
```

A test that recreates a channel with the same name right after `destroy()` and expects
empty history (not a thrown `no such table` error) is what catches a regression here.

## 3. Never gate test completion on your own outbound WebSocket close handshake

A test that calls `clientSocket.close()` and then `await`s the resulting `"close"` event
on that *same client* socket is unreliable in this pool — it can hang even after the
*server* side has already logged handling the close. A server-**initiated** close (for
example a Durable Object's own `destroy()` calling `ws.close(code, reason)`) reliably
delivers its close event to the client. Only the client-initiated round trip is the
problem.

**Fix:** never depend on the client-initiated close round trip for test correctness or
cleanup.

- Call `socket.close()` best-effort, without awaiting a `"close"` event on it.
- Use `evictAllDurableObjects({ webSockets: "close" })` (from `cloudflare:test`) in
  `afterEach` as the **one unconditional, documented mechanism** guaranteeing no socket
  outlives a test.

```ts
import { evictAllDurableObjects } from "cloudflare:test";

describe("ChatRoom coordination", () => {
  const openSockets = new Set<WebSocket>();

  afterEach(async () => {
    // Best-effort, un-awaited: do not depend on this round-trip completing.
    for (const socket of openSockets) {
      if (
        socket.readyState !== WebSocket.CLOSED &&
        socket.readyState !== WebSocket.CLOSING
      ) {
        socket.close();
      }
    }
    openSockets.clear();
    // The one guarantee that no socket outlives this test.
    await evictAllDurableObjects({ webSockets: "close" });
  });

  // ...register every socket a test opens into `openSockets` as soon as it's created.
});
```

## 4. Prefer storage inspection over racing a message against a timer

A test asserting something did **not** happen — routing isolation between two Durable
Object instances, a rejected/invalid message that must never be persisted — is far more
reliable checking `runInDurableObject`'s storage state directly than opening a second
socket and racing an expected non-event against a `setTimeout`. The timer-race pattern is
inherently flaky and, in this project, directly correlated with the hangs described
elsewhere in this skill.

```ts
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

function messageCount(channel: string): Promise<number> {
  return runInDurableObject(env.CHAT_ROOM.getByName(channel), (_instance, state) => {
    return state.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages")
      .one().count;
  });
}

it("keeps channels isolated: a message sent in one channel is never stored in another", async () => {
  // ...send a message only into channelA's socket...
  expect(await messageCount(channelA)).toBe(1);
  expect(await messageCount(channelB)).toBe(0); // inspected, not raced against a timer
});
```

## 5. Filter WebSocket assertions by frame `type`, registered before the trigger

A hibernatable WebSocket server frequently sends more than one frame per action — for
example broadcasting a presence update immediately after replaying history on connect.
That means a client's *next* frame is not necessarily the frame under test. Asserting by
arrival order or raw frame count is fragile.

**Fix:** register a `"message"` listener that resolves only when it sees a specific
expected `type`, silently ignoring every other frame, and always add that listener
**before** performing the action expected to trigger it (so there is no race between
registering the listener and the frame arriving).

```ts
function nextMessageOfType(
  socket: WebSocket,
  type: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const handler = (event: MessageEvent) => {
      const decoded = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (decoded.type === type) {
        socket.removeEventListener("message", handler);
        resolve(decoded);
      }
    };
    socket.addEventListener("message", handler);
  });
}

// Register the listener before the action that triggers the frame:
const broadcast = nextMessageOfType(socket, "message");
socket.send(JSON.stringify({ body: "Hello, room" }));
await expect(broadcast).resolves.toMatchObject({ type: "message", message: { body: "Hello, room" } });
```

This avoids both assuming an exact frame count/order and the complexity of a
general-purpose event queue.

## 6. Never return a `Response` (or other non-plain object) across `runInDurableObject`

`runInDurableObject`'s callback runs across an isolate boundary; its return value must be
plain and structured-clone-friendly. Returning a `Response` object (or a `Request`, or
anything else non-plain) from the callback so a test can assert on it *outside* the
callback reliably hung the same `afterEach` eviction cleanup described in rule 3 — even
when the callback itself completed synchronously and never touched a real WebSocket. The
hang then cascades into every following test in the file, since the stuck eviction call
never resolves.

**Fix:** read whatever plain fields the assertion actually needs — `response.status`,
`response.webSocket !== null`, and so on — **inside** the callback, and return only
those.

```ts
// ❌ Hangs the next afterEach's evictAllDurableObjects() call:
const response = await runInDurableObject(stub, (instance) =>
  instance.fetch(new Request("https://chat.internal/")),
);
expect(response.status).toBe(400);

// ✅ Extract plain fields inside the callback instead:
const { status, hasWebSocket } = await runInDurableObject(stub, (instance) => {
  const response = instance.fetch(new Request("https://chat.internal/"));
  return { status: response.status, hasWebSocket: response.webSocket !== null };
});
expect(status).toBe(400);
expect(hasWebSocket).toBe(false);
```

The same rule applies to any other non-plain value a Durable Object method might
otherwise tempt you to return directly from a `runInDurableObject` callback.

## 7. `evictAllDurableObjects()` hangs on a Durable Object that just called its own
   `ctx.abort()` (for example an Agents-SDK `Agent.destroy()`) — use
   `abortAllDurableObjects()` instead

Rule 3's `evictAllDurableObjects({ webSockets: "close" })` is the right default cleanup,
but it hangs indefinitely — not merely flakes — the first time it runs after a test called
`.destroy()` on an Agents-SDK `Agent` (`agents` package, `AIChatAgent` included). Reading
the installed `agents` package: the base `Agent.destroy()` calls
`this.ctx.abort("destroyed")` from a deferred `setTimeout(..., 0)` so the RPC call that
triggered it resolves cleanly first — but the abort itself permanently breaks that
instance's output gate. `evictAllDurableObjects()`'s own documented behavior ("eviction
waits for in-flight requests to drain, with a timeout") then hangs trying to gracefully
drain an actor whose gate is already broken. Observed live: an uncaught
`workerd/api/actor-state.c++:1178: failed: broken.outputGateBroken; jsg.Error: destroyed`
exception, immediately followed by the `afterEach` hook itself timing out at Vitest's
default 10-second `hookTimeout` (see `docs/DECISIONS.md` item 19).

**Fix:** in any integration test file where a test might call `.destroy()` on an
Agents-SDK `Agent`, use `abortAllDurableObjects()` (also from `cloudflare:test`) in place
of `evictAllDurableObjects()`. It performs the same "reset every Durable Object instance
so no live connection outlives a test" job by hard-resetting every instance instead of
attempting a graceful drain-and-wait eviction — confirmed live to not hang on an
already-aborted actor, and to still force-disconnect an *ordinary*, non-destroyed
instance's hibernatable WebSocket in the same file's other tests.

```ts
import { abortAllDurableObjects } from "cloudflare:test";

afterEach(async () => {
  for (const socket of openSockets) {
    if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
      socket.close();
    }
  }
  openSockets.clear();
  // Not evictAllDurableObjects(): a test in this file calls `.destroy()` on an Agents-SDK
  // Agent, whose base destroy() calls ctx.abort() -- evicting that instance afterward hangs
  // trying to gracefully drain an already-broken output gate (rule 7).
  await abortAllDurableObjects();
});
```

A hand-rolled `DurableObject` subclass whose own `destroy()` never calls `ctx.abort()`
(rule 2's `ChatRoom` example, for instance) never hits this — `evictAllDurableObjects()`
remains the right default for a file where no test calls an SDK method that self-aborts.

## Putting it together: a minimal, non-flaky test shape

```ts
import { env } from "cloudflare:workers";
import { evictAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

describe("ChatRoom coordination", () => {
  const openSockets = new Set<WebSocket>();

  afterEach(async () => {
    for (const socket of openSockets) {
      if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
        socket.close(); // best-effort, not awaited (rule 3)
      }
    }
    openSockets.clear();
    await evictAllDurableObjects({ webSockets: "close" }); // the one real guarantee (rule 3)
  });

  it("broadcasts a persisted message to every participant in the same channel", async () => {
    // ...open sockets through the real Worker route, track them in openSockets...
    // ...register a nextMessageOfType() listener before sending (rule 5)...
    // ...assert on plain values only, never a raw Response/Request (rule 6)...
    // ...prefer runInDurableObject storage inspection over a timer race for absence (rule 4)...
  });
});
```

Also set `fileParallelism: false` in this project's `vitest.config.ts` (rule 1), and make
sure any storage-erasing RPC re-initializes schema before returning (rule 2).

## Source

This skill mirrors `docs/DECISIONS.md` item 8 verbatim in spirit. If a new WebSocket/
Durable-Object testing gotcha is discovered, log it in `docs/DECISIONS.md` first (per
that file's own convention), then fold it into this skill so future work benefits from
it immediately instead of rediscovering it.
