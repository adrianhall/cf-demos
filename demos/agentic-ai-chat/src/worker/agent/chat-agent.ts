import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  generateText,
  type GenerateTextOnFinishCallback,
  type LanguageModel,
  streamText,
  type ToolSet,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  CHAT_REMOVED_CLOSE_CODE,
  type ChatMetadataUpdatedFrame,
  type ChatRemovedFrame,
} from "../../agent-protocol";
import { ChatRepository } from "../chats/repository";
import {
  type ChatRoute,
  DEFAULT_CHAT_ROUTE,
  resolveDynamicRouteModelId,
} from "../chats/route";
import { sanitizeTitle } from "../chats/title";

/**
 * System prompt for Phase 3's auto-title generation (US-2): a second, non-streaming `env.AI`
 * call issued from the same `onFinish` handler as the turn itself. Section 11 confirms two
 * `env.AI` calls in flight on the same `ChatAgent` instance need no special handling.
 */
const TITLE_SYSTEM_PROMPT =
  "Generate a short chat title (four words or fewer) summarizing the conversation below. " +
  "Respond with only the title text -- no quotation marks, no trailing punctuation, no " +
  "preamble.";

/**
 * Props threaded into a `ChatAgent` instance by `getAgentByName()` at routing time (delivered to
 * `onStart()`, per Spike A's confirmed mechanism -- never a field the client's own message body
 * can set). The Worker's routing layer (`src/worker/routes/chats.ts`) extracts this from the
 * Cloudflare Access-verified identity, after confirming that identity owns the D1 `chats` row
 * for this chat ID -- `route` is re-read from that same D1 row on every request, so a route
 * change made via `PATCH /api/chats/:id` always reaches the next turn with no separate
 * invalidation step (docs/06-AGENTIC-CHAT.md Phase 4, US-3).
 */
export interface ChatAgentProps extends Record<string, unknown> {
  /** Verified Cloudflare Access identity that owns this chat. */
  ownerEmail: string;
  /** This chat's currently persisted governed model route. */
  route: ChatRoute;
}

/**
 * One Durable Object instance per chat (docs/06-AGENTIC-CHAT.md Section 6.2), holding a
 * persistent, resumable conversation via the Agents SDK's `AIChatAgent`. `AIChatAgent` already
 * provides message persistence, resumable streaming, and WebSocket sync (Spike A); this
 * subclass's only job is to answer each turn by calling `streamText()` against Workers AI,
 * routed through AI Gateway.
 */
export class ChatAgent extends AIChatAgent<Env, unknown, ChatAgentProps> {
  /** Captured from `props` on first start; never trusted from client-supplied message data. */
  private ownerEmail: string | undefined;

  /** Captured from `props` on first start; the chat's persisted route at the moment this
   * instance was last routed to, re-derived from D1 by `src/worker/routes/chats.ts`'s
   * `ownedAgentStub()` on every request (docs/06-AGENTIC-CHAT.md Phase 4, US-3). Falls back to
   * {@link DEFAULT_CHAT_ROUTE} if a wake ever occurs with no props at all (mirrors
   * `onStart()`'s existing `ownerEmail` fallback below -- see the "no-props" integration test
   * this class already has for that case). */
  private route: ChatRoute = DEFAULT_CHAT_ROUTE;

  /**
   * `partyserver`'s `Server.onStart()` lifecycle hook, called once per wake with the `props`
   * passed to `getAgentByName()` at routing time (Spike A, Section 7) -- this is how the
   * Cloudflare Access-verified owner identity reaches this Durable Object without the client
   * ever supplying it directly.
   */
  override async onStart(props?: ChatAgentProps): Promise<void> {
    this.ownerEmail = props?.ownerEmail;
    this.route = props?.route ?? DEFAULT_CHAT_ROUTE;
  }

  /**
   * Answers one chat turn by streaming a Workers AI model's response through AI Gateway.
   *
   * `this.messages` is `AIChatAgent`'s own persisted transcript (backed by its dedicated SQLite
   * tables, confirmed by Spike A to survive across separate WebSocket connections to the same
   * chat -- the mechanism behind US-1's "reload and reconnect resumes the same conversation"
   * acceptance criterion). `convertToModelMessages()` is `async` in the installed `ai` version
   * (Spike A, Section 3) and must be awaited.
   *
   * @param onFinish `AIChatAgent`'s own completion callback; passed straight through to
   * `streamText()` so the framework can persist the finished assistant message, wrapped so this
   * class's own Phase 3 bookkeeping (`afterTurnCompleted()`) runs immediately afterward.
   * **This does not mean the client has already seen those writes land by the time it observes
   * the turn as done** -- `toUIMessageStreamResponse()` enqueues the UI-message-stream's
   * `{"type":"finish"}` part (the signal `useChatAgent.ts` uses to flip a turn to `"done"`) as
   * soon as the model itself finishes generating, independent of whether this `onFinish`
   * callback has resolved. Only the wire-level `done: true` flag on the *final* response frame
   * is actually gated behind it, and nothing client-visible reacts to that flag alone. That is
   * exactly why `afterTurnCompleted()` broadcasts its own completion (see its JSDoc) rather than
   * this method relying on the turn's streaming status to signal "the sidebar's data is ready."
   * Phase 6 extends this same wrapper for the cost ledger.
   * @param options Carries the turn's `abortSignal` (propagated to `streamText()` so a client
   * cancellation actually stops upstream generation, not just the visible response) and any
   * client-supplied tool schemas (unused until Phase 9/10's tools).
   * @returns The AI SDK's UI-message-stream `Response`, forwarded verbatim over the chat
   * WebSocket connection by `AIChatAgent`'s own wire protocol.
   */
  async onChatMessage(
    onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const workersai = createWorkersAI({ binding: this.env.AI });
    // Governed model selection (docs/06-AGENTIC-CHAT.md Phase 4, US-3): `this.route` is never a
    // client-supplied model id -- it is one of exactly two literal strings, resolved here to the
    // real AI Gateway dynamic route name via Terraform-sourced Worker vars
    // (`resolveDynamicRouteModelId()`, `src/worker/chats/route.ts`), then called through
    // `env.AI.run()`'s `dynamic/<name>` run path (confirmed by Spikes B/F). Which underlying
    // model that route actually resolves to is editable in the AI Gateway dashboard without a
    // Worker redeploy.
    const model = workersai(resolveDynamicRouteModelId(this.route, this.env), {
      gateway: { id: this.env.AI_GATEWAY_ID },
    });

    const result = streamText({
      model,
      system:
        `You are a helpful assistant embedded in a private, authenticated chat for ` +
        `${this.ownerEmail ?? "the signed-in user"}. Answer directly and concisely.`,
      messages: await convertToModelMessages(this.messages),
      abortSignal: options?.abortSignal,
      onFinish: async (event) => {
        await onFinish(event);
        await this.afterTurnCompleted(model);
      },
    });

    return result.toUIMessageStreamResponse();
  }

  /**
   * Bump this chat's D1 recency timestamp and, the first time only, generate and persist a
   * short title from the conversation so far (docs/06-AGENTIC-CHAT.md Phase 3, US-2), then
   * broadcast {@link ChatMetadataUpdatedFrame} so a connected sidebar refreshes at the moment
   * this data is actually ready -- not at the moment the model's answer stopped streaming.
   *
   * **Why a broadcast, not just relying on the turn reaching `"done"`:** a live measurement
   * (two-chunk model response, artificially slow title call) showed the client-visible
   * `{"type":"finish"}` UI part arriving well before this whole method's own writes land --
   * `toUIMessageStreamResponse()` enqueues it as soon as the model itself finishes generating,
   * with no dependency on this `onFinish` callback resolving first. A sidebar that reloaded on
   * the turn's own streaming status reliably raced this method and won, showing the chat's
   * *previous* title/recency until an unrelated later reload happened to observe the finished
   * write. Broadcasting this method's own completion, instead of overloading the turn's
   * streaming status as a second, unrelated signal, closes that gap directly.
   *
   * Both D1 steps are best-effort and independently guarded: by the time this method runs, the
   * model's own answer has already fully streamed back to the client, so a write failure here
   * must never surface as a failed turn -- it is logged and swallowed instead, matching Section
   * 11's general "a tool/side-effect failure must never abort the turn" principle applied to
   * this demo's own bookkeeping. The broadcast itself is unconditional (success, failure, or a
   * skipped title generation all still bump recency and are all still worth a sidebar refresh).
   *
   * @param model The same `LanguageModel` instance `onChatMessage()` built for the turn itself,
   * reused for the title-generation call (Section 11: two `env.AI` calls in flight on the same
   * `ChatAgent` instance need no special handling, per Spike F's concurrency finding).
   */
  private async afterTurnCompleted(model: LanguageModel): Promise<void> {
    const chatId = this.name;
    const repository = new ChatRepository(this.env.DB);

    try {
      await repository.touch(chatId);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "chat_touch_failed",
          chatId,
          error: String(error),
        }),
      );
    }

    try {
      const chat = await repository.findById(chatId);
      if (chat !== null && chat.title === null) {
        // The first exchange only (`this.messages.slice(0, 2)`): by construction this only ever
        // runs while `title` is still `null`, which -- barring every generation attempt failing
        // outright -- is exactly the chat's first completed turn.
        const titleResult = await generateText({
          model,
          system: TITLE_SYSTEM_PROMPT,
          messages: await convertToModelMessages(this.messages.slice(0, 2)),
        });
        const title = sanitizeTitle(titleResult.text);
        if (title.length > 0) {
          await repository.setTitleIfUnset(chatId, title);
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "chat_title_failed",
          chatId,
          error: String(error),
        }),
      );
    }

    this.broadcast(
      JSON.stringify({
        type: "chat_metadata_updated",
      } satisfies ChatMetadataUpdatedFrame),
    );
  }

  /**
   * Notify every currently connected browser that this chat is being removed, with close code
   * {@link CHAT_REMOVED_CLOSE_CODE} the `useChatAgent` composable distinguishes from a
   * transient drop (docs/06-AGENTIC-CHAT.md Section 11, "a chat is deleted while a turn is in
   * flight" -- mirrors `demos/chat`'s `ChatRoom.destroy()`), before delegating to the Agents
   * SDK's own `destroy()`. Reading the installed `agents` package confirms that base method
   * drops every internal table, deletes the alarm, and aborts the isolate via a deferred
   * `setTimeout(..., 0)` -- so this override, and the RPC call that invoked it
   * (`src/worker/routes/chats.ts`'s `DELETE /:id`), both resolve cleanly before that abort ever
   * runs.
   */
  override async destroy(): Promise<void> {
    for (const connection of this.getConnections()) {
      connection.send(
        JSON.stringify({ type: "chat_removed" } satisfies ChatRemovedFrame),
      );
      connection.close(CHAT_REMOVED_CLOSE_CODE, "Chat removed.");
    }
    await super.destroy();
  }
}
