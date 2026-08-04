import {
  badRequest,
  notFound,
  unprocessableContent,
} from "@adrianhall/cloudflare-toolkit/errors";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import type { ChatAgent, ChatAgentProps } from "../agent/chat-agent";
import type { AppBindings } from "../bindings";
import { CHAT_ROUTES, isChatRoute } from "../chats/route";
import { ChatRepository } from "../chats/repository";
import { ChatFilesRepository } from "../files/repository";
import { contentDisposition, getChatFile } from "../files/storage";
import { UsageRepository } from "../usage/repository";
import { emptyUsageSummary } from "../usage/types";
import { UserRepository } from "../users/repository";

/** Authenticated chat directory and agent-routing API mounted at `/api/chats`. */
export const chatsRouter = new Hono<AppBindings>();

/**
 * Resolve the `ChatAgent` Durable Object stub for a chat ID, after confirming in D1 that the
 * verified identity owns it. Threads that identity in as `getAgentByName()`'s `props`
 * (docs/06-AGENTIC-CHAT.md Section 6.2/6.5, Spike A Section 7) so it reaches the Durable
 * Object's `onStart()` hook without ever coming from client-supplied request data.
 *
 * @param env Worker bindings (`DB`, `CHAT_AGENT`).
 * @param id Chat ID from the request path.
 * @param ownerEmail Verified Cloudflare Access identity making the request.
 * @returns The owning chat's `ChatAgent` stub.
 * @throws {ProblemDetailsError} `notFound` when the chat does not exist or is owned by a
 * different identity -- the two are deliberately indistinguishable to the caller (Phase 2,
 * step 3), so this never confirms another user's chat ID is valid.
 */
async function ownedAgentStub(
  env: AppBindings["Bindings"],
  id: string,
  ownerEmail: string,
): Promise<DurableObjectStub<ChatAgent>> {
  const repository = new ChatRepository(env.DB);
  const chat = await repository.findOwned(id, ownerEmail);
  if (chat === null) {
    throw notFound({ detail: "Chat not found." });
  }
  // Read alongside `chat.route`, for the same reason: this owner's admin-assigned business
  // segment (docs/06-AGENTIC-CHAT.md Phase 8, US-7) steers AI Gateway's own metadata-driven
  // model routing, so it must come from D1 here -- never from anything the client's own
  // message body could set -- and be re-read on every request, exactly like `route`, so a
  // `PATCH /api/admin/users/:email` change reaches this owner's very next turn with no
  // separate invalidation step.
  const owner = await new UserRepository(env.DB).findByEmail(ownerEmail);
  // Threading this chat's currently persisted route (and this owner's business segment) in as
  // props (docs/06-AGENTIC-CHAT.md Phase 4/8, US-3/US-7) re-derives both from D1 on every
  // request that reaches the Durable Object, rather than caching either anywhere -- so a route
  // changed via `PATCH /:id` (below), or a business segment changed by an admin, always reaches
  // the next `onChatMessage()` call with no separate invalidation step needed.
  return getAgentByName<Env, ChatAgent, ChatAgentProps>(env.CHAT_AGENT, id, {
    props: {
      business: owner?.business ?? null,
      ownerEmail,
      route: chat.route,
    },
  });
}

/** Create a new chat, owned by the signed-in identity, with no messages yet. */
chatsRouter.post("/", async (context) => {
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const repository = new ChatRepository(context.env.DB);
  const chat = await repository.create(ownerEmail);
  context.get("LOGGER").info("chat_created", { chatId: chat.id });
  return context.json({ chat }, 201);
});

/**
 * Change a chat's governed model route (docs/06-AGENTIC-CHAT.md Phase 4, US-3). The client
 * sends one of exactly two literal strings -- `"basic"` or `"reasoning"` -- never a raw model
 * id (Section 6.3's "the Worker resolves by exact match" rule); `isChatRoute()` rejects anything
 * else with `422` before any D1 write. Only allowed while the chat has no completed turns yet
 * (`ChatRepository.setRouteIfUnstarted()`'s `title IS NULL` guard) -- mirroring a real product's
 * "can't switch models mid-thread" affordance (Phase 4, step 3). A chat that already has a
 * title reports `422` here too, distinguished from an invalid route only by its `detail` text;
 * both are "the request cannot be processed as sent," not "malformed request shape," so this
 * demo does not introduce a separate `409` for the second case (AGENTS.md's toolkit error
 * helpers have no `conflict()` -- see the two validation modules in `demos/todo-app`/
 * `demos/chat` for the same `unprocessableContent()`-for-state-conflicts convention).
 */
chatsRouter.patch("/:id", async (context) => {
  const id = context.req.param("id");
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const body = await context.req.json().catch(() => null);
  const route = (body as { route?: unknown } | null)?.route;
  if (!isChatRoute(route)) {
    throw unprocessableContent({
      detail: `route must be one of: ${CHAT_ROUTES.join(", ")}.`,
    });
  }
  const repository = new ChatRepository(context.env.DB);
  const chat = await repository.findOwned(id, ownerEmail);
  if (chat === null) {
    throw notFound({ detail: "Chat not found." });
  }
  const updated = await repository.setRouteIfUnstarted(id, ownerEmail, route);
  if (!updated) {
    throw unprocessableContent({
      detail:
        "This chat's route can only be changed before its first turn completes.",
    });
  }
  context.get("LOGGER").info("chat_route_changed", { chatId: id, route });
  return context.json({ chat: { ...chat, route } });
});

/**
 * List the signed-in identity's own chat directory, most recently updated first -- the
 * sidebar's listing (docs/06-AGENTIC-CHAT.md Phase 3, US-2), each entry now also carrying its
 * running cost/token summary and estimated/gateway confirmation mix (Phase 6, US-5). Reads
 * `aggregateForOwner()` in one query for every chat this identity owns, rather than waking each
 * chat's own `ChatAgent` Durable Object to read `state.usage` -- Section 6.6a's documented,
 * deliberate REST-driven path for the sidebar, distinct from the currently-open chat's own
 * live-pushed total. Conversation content itself is never included here; a client loads a
 * specific chat's history separately via `GET /api/chats/:id/get-messages`.
 */
chatsRouter.get("/", async (context) => {
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const repository = new ChatRepository(context.env.DB);
  const [chats, usageByChat] = await Promise.all([
    repository.listOwned(ownerEmail),
    new UsageRepository(context.env.DB).aggregateForOwner(ownerEmail),
  ]);
  return context.json({
    chats: chats.map((chat) => ({
      ...chat,
      usage: usageByChat.get(chat.id) ?? emptyUsageSummary(),
    })),
  });
});

/**
 * Delete a chat: tear down its `ChatAgent` Durable Object state before removing the D1
 * directory row -- destroying the live coordination state first, then the row that lets
 * anyone find it again, mirrors `demos/chat`'s `ChatRoom.destroy()` teardown order.
 * `ownedAgentStub()` rejects a foreign or nonexistent chat id with `404` before either step
 * runs.
 *
 * `stub.destroy()`'s own RPC call is deliberately not allowed to fail this route: the Agents
 * SDK's base `Agent.destroy()` calls `ctx.abort()` from a deferred `setTimeout(..., 0)`
 * specifically so the RPC response reaches its caller cleanly first -- but a live-reproduced
 * bug report confirmed that guarantee is not airtight (a real reported case where the
 * destroy() RPC call itself rejected). Left unguarded, that exception aborted this whole route
 * *before* the D1 row was removed, leaving a "zombie" chat: its Durable Object storage already
 * wiped (so reopening it showed an empty transcript), but its directory row still present (so
 * the sidebar kept showing it as if deletion had silently failed) -- while the client saw a
 * generic `500`, not the `204` this operation is actually supposed to end in. Catching and
 * logging the failure here, then unconditionally proceeding to remove the D1 row regardless,
 * closes that gap: whatever `destroy()` itself accomplished (typically the full teardown, per
 * the same reproduction) is not further compounded by leaving its directory entry behind too.
 */
chatsRouter.delete("/:id", async (context) => {
  const id = context.req.param("id");
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const stub = await ownedAgentStub(context.env, id, ownerEmail);
  try {
    await stub.destroy();
  } catch (error) {
    context.get("LOGGER").warn("chat_destroy_failed", {
      chatId: id,
      error: String(error),
    });
  }
  const repository = new ChatRepository(context.env.DB);
  await repository.remove(id, ownerEmail);
  context.get("LOGGER").info("chat_deleted", { chatId: id });
  return new Response(null, { status: 204 });
});

/**
 * Forward to `AIChatAgent`'s own built-in message-history endpoint -- it treats any GET request
 * whose path ends in `get-messages` as a request for the full persisted transcript (source-read
 * from the installed `@cloudflare/ai-chat` package; see `EXPLAIN-DEMO.md`). This is what lets a
 * reloaded page repopulate its transcript from the Durable Object's own durable storage rather
 * than from browser memory (US-1's acceptance criterion) before the WebSocket connection below
 * ever opens.
 */
chatsRouter.get("/:id/get-messages", async (context) => {
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const stub = await ownedAgentStub(
    context.env,
    context.req.param("id"),
    ownerEmail,
  );
  return stub.fetch(context.req.raw);
});

/** Forward an authenticated WebSocket upgrade to the owning chat's `ChatAgent` instance. */
chatsRouter.get("/:id/ws", async (context) => {
  if (context.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    throw badRequest({ detail: "Expected a WebSocket upgrade request." });
  }
  const id = context.req.param("id");
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;
  const stub = await ownedAgentStub(context.env, id, ownerEmail);
  context.get("LOGGER").info("chat_connected", { chatId: id });
  return stub.fetch(context.req.raw);
});

/**
 * Download a file the agent's `writeMarkdown` tool wrote to this chat (docs/06-AGENTIC-CHAT.md
 * Phase 9, US-8). Two independent checks, both required, enforce "only the chat's owner can
 * download it": {@link ChatRepository.findOwned} confirms the requesting identity owns `id`
 * itself, and {@link ChatFilesRepository.findByChatAndId} confirms `fileId` actually belongs to
 * that same chat -- either failing reports the same `404`, indistinguishable from each other or
 * from a chat/file that never existed at all, mirroring `ownedAgentStub()`'s own rationale.
 */
chatsRouter.get("/:id/files/:fileId", async (context) => {
  const chatId = context.req.param("id");
  const fileId = context.req.param("fileId");
  const ownerEmail = context.get("Cloudflare_Access_Identity").email;

  const chat = await new ChatRepository(context.env.DB).findOwned(
    chatId,
    ownerEmail,
  );
  if (chat === null) {
    throw notFound({ detail: "Chat not found." });
  }
  const file = await new ChatFilesRepository(context.env.DB).findByChatAndId(
    chatId,
    fileId,
  );
  if (file === null) {
    throw notFound({ detail: "File not found." });
  }
  const object = await getChatFile(context.env.FILES, file.r2Key);
  if (object === null) {
    throw notFound({ detail: "File not found." });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Disposition", contentDisposition(file.filename));
  context
    .get("LOGGER")
    .info("chat_file_downloaded", { chatId, fileId, filename: file.filename });
  return new Response(object.body, { headers });
});
