import { badRequest, notFound } from "@adrianhall/cloudflare-toolkit/errors";
import { getAgentByName } from "agents";
import { Hono } from "hono";
import type { ChatAgent, ChatAgentProps } from "../agent/chat-agent";
import type { AppBindings } from "../bindings";
import { ChatRepository } from "../chats/repository";

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
  return getAgentByName<Env, ChatAgent, ChatAgentProps>(env.CHAT_AGENT, id, {
    props: { ownerEmail },
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
