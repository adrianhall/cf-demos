import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  generateText,
  type GenerateTextOnFinishCallback,
  type LanguageModel,
  type LanguageModelUsage,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  CHAT_REMOVED_CLOSE_CODE,
  type ChatMetadataUpdatedFrame,
  type ChatRemovedFrame,
  type UsageReconcileExhaustedFrame,
  type UsageReconciledFrame,
} from "../../agent-protocol";
import { findLogByCorrelationId } from "../ai-gateway/logs";
import { ChatRepository } from "../chats/repository";
import {
  type ChatRoute,
  DEFAULT_CHAT_ROUTE,
  resolveDynamicRouteModelId,
} from "../chats/route";
import { sanitizeTitle } from "../chats/title";
import { estimateCostUsd, modelIdForRoute } from "../usage/pricing";
import { UsageRepository } from "../usage/repository";
import { type ChatUsageSummary, emptyUsageSummary } from "../usage/types";
import type { Business } from "../users/business";
import { createWriteMarkdownTool } from "./tools/write-markdown";

/**
 * Bound on how many `streamText()` steps one turn may take (docs/06-AGENTIC-CHAT.md Phase 9,
 * US-8). `streamText()`'s own default (`stepCountIs(1)`) stops the instant the model emits a
 * tool call, with no further step to let it respond to that tool's result -- which would leave
 * a successful `writeMarkdown` call with no assistant text acknowledging it. `4` is generous
 * headroom for "call a tool, then respond" (and, from Phase 10/11 onward, a second tool in the
 * same turn) without letting a misbehaving model loop indefinitely.
 */
const MAX_TURN_STEPS = 4;

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
 * Delay (seconds) before `reconcileUsage()`'s first attempt, scheduled from `onFinish` the
 * moment a turn's estimated `chat_usage` row is written. Spike F measured 267ms-4,731ms
 * (~2.2s average) of real lag between a call completing and its log row becoming queryable via
 * the logs-list endpoint on a freshly created, otherwise-idle dedicated gateway -- 10s gives
 * comfortable headroom above that on this demo's own shared gateway (docs/06-AGENTIC-CHAT.md
 * Section 6.6).
 */
const INITIAL_RECONCILE_DELAY_SECONDS = 10;

/** Backoff (seconds) applied to each retry after the first reconciliation attempt finds nothing
 * yet (Section 6.6). */
const RECONCILE_BACKOFF_SECONDS = 15;

/** Bounded retry budget: the initial attempt plus this many more before a still-unreconciled
 * row is left `"estimated"` permanently (Section 6.6 -- "a legitimate, visible outcome, not a
 * bug to hide"). Three attempts total, ~40s worst case (10s + 15s + 15s). */
const MAX_RECONCILE_ATTEMPTS = 3;

/**
 * Payload `reconcileUsage()`'s own scheduled task carries (docs/06-AGENTIC-CHAT.md Section 6.6,
 * Phase 6). Serialized to the Agents SDK's own schedule storage, so every field must be a plain,
 * structured-clone-friendly value.
 */
export interface ReconcileUsagePayload {
  /** The `chat_usage` row this task is trying to reconcile. */
  readonly chatUsageId: string;
  /** The same turn's correlation id -- the only key `findLogByCorrelationId()` can look up. */
  readonly correlationId: string;
}

/** State this class's `AIChatAgent`/`Agent` base persists and syncs to every connected client
 * (docs/06-AGENTIC-CHAT.md Section 6.6a). Spike A confirmed `AIChatAgent` occupies no part of
 * this generic for message history (that lives entirely in its own dedicated SQLite tables), so
 * this shape is free to hold only this demo's own aggregate projection. */
export interface ChatAgentState {
  /** This chat's current cost/token totals, always re-derived from D1's `chat_usage` table
   * (`UsageRepository.aggregateForChat()`) -- never independently mutated. */
  readonly usage: ChatUsageSummary;
}

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
  /**
   * This chat owner's admin-assigned business segment (docs/06-AGENTIC-CHAT.md Phase 8, US-7),
   * `null` until an admin sets one (`PATCH /api/admin/users/:email`, Phase 7). Re-read from D1
   * alongside `route` by `../routes/chats.ts`'s `ownedAgentStub()` on every request, so an
   * admin's metadata change reaches the very next turn with no separate invalidation step,
   * mirroring `route`'s own re-derivation -- never a value the client's own message body could
   * set.
   */
  business: Business | null;
}

/**
 * One Durable Object instance per chat (docs/06-AGENTIC-CHAT.md Section 6.2), holding a
 * persistent, resumable conversation via the Agents SDK's `AIChatAgent`. `AIChatAgent` already
 * provides message persistence, resumable streaming, and WebSocket sync (Spike A); this
 * subclass's only job is to answer each turn by calling `streamText()` against Workers AI,
 * routed through AI Gateway.
 */
export class ChatAgent extends AIChatAgent<
  Env,
  ChatAgentState,
  ChatAgentProps
> {
  /** This chat's initial, pre-first-turn cost/token state (docs/06-AGENTIC-CHAT.md Section
   * 6.6a) -- overridden per Agent's own "override to provide default state values" contract. */
  override initialState: ChatAgentState = { usage: emptyUsageSummary() };

  /** Captured from `props` on first start; never trusted from client-supplied message data. */
  private ownerEmail: string | undefined;

  /** Captured from `props` on first start; the chat's persisted route at the moment this
   * instance was last routed to, re-derived from D1 by `src/worker/routes/chats.ts`'s
   * `ownedAgentStub()` on every request (docs/06-AGENTIC-CHAT.md Phase 4, US-3). Falls back to
   * {@link DEFAULT_CHAT_ROUTE} if a wake ever occurs with no props at all (mirrors
   * `onStart()`'s existing `ownerEmail` fallback below -- see the "no-props" integration test
   * this class already has for that case). */
  private route: ChatRoute = DEFAULT_CHAT_ROUTE;

  /** Captured from `props` on first start; this chat owner's admin-assigned business segment
   * at the moment this instance was last routed to, re-derived from D1 by
   * `src/worker/routes/chats.ts`'s `ownedAgentStub()` on every request, exactly like
   * {@link route} (docs/06-AGENTIC-CHAT.md Phase 8, US-7). `null` until an admin assigns one, or
   * if a wake ever occurs with no props at all. */
  private business: Business | null = null;

  /**
   * `partyserver`'s `Server.onStart()` lifecycle hook, called once per wake with the `props`
   * passed to `getAgentByName()` at routing time (Spike A, Section 7) -- this is how the
   * Cloudflare Access-verified owner identity reaches this Durable Object without the client
   * ever supplying it directly.
   */
  override async onStart(props?: ChatAgentProps): Promise<void> {
    this.ownerEmail = props?.ownerEmail;
    this.route = props?.route ?? DEFAULT_CHAT_ROUTE;
    this.business = props?.business ?? null;
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
    // Minted before the call, per docs/06-AGENTIC-CHAT.md Section 6.6/Spike F: this is the
    // *only* way to later find this turn's own AI Gateway log row. `env.AI.aiGatewayLogId` is
    // always `null` for a dynamic-route call, so it cannot be used for this instead.
    const correlationId = crypto.randomUUID();
    // Governed model selection (docs/06-AGENTIC-CHAT.md Phase 4, US-3): `this.route` is never a
    // client-supplied model id -- it is one of exactly two literal strings, resolved here to the
    // real AI Gateway dynamic route name via Terraform-sourced Worker vars
    // (`resolveDynamicRouteModelId()`, `src/worker/chats/route.ts`), then called through
    // `env.AI.run()`'s `dynamic/<name>` run path (confirmed by Spikes B/F). Which underlying
    // model that route actually resolves to is editable in the AI Gateway dashboard without a
    // Worker redeploy.
    const model = workersai(resolveDynamicRouteModelId(this.route, this.env), {
      gateway: {
        id: this.env.AI_GATEWAY_ID,
        // `business` steers AI Gateway's own conditional model-node branching on both routes
        // (docs/06-AGENTIC-CHAT.md Phase 8, US-7; `infra/agentic-ai-chat.tf`'s `business-check`
        // element) -- read from D1 at routing time (`../routes/chats.ts`'s `ownedAgentStub()`),
        // never anything the client's own message body could set, so "different business
        // segments get different models" is governed entirely platform-side (Section 6.3's
        // whole point), with zero client-visible branching. `null` (no business assigned yet)
        // is a valid AI Gateway metadata value and simply never matches the conditional's
        // `"field"` check, falling through to the same branch as any other non-"field" value.
        metadata: { correlationId, business: this.business },
      },
    });

    const result = streamText({
      model,
      system:
        `You are a helpful assistant embedded in a private, authenticated chat for ` +
        `${this.ownerEmail ?? "the signed-in user"}. Answer directly and concisely. When you ` +
        `use the writeMarkdown tool, briefly confirm what you saved in your reply.`,
      messages: await convertToModelMessages(this.messages),
      abortSignal: options?.abortSignal,
      // `writeMarkdown` (docs/06-AGENTIC-CHAT.md Phase 9, US-8) -- bound to this chat's own R2/D1
      // bindings and instance name, never a shared or cross-chat instance. Threading this same
      // turn's `correlationId` in resolves the doc's own Section 15 open question ("exact
      // correlation key between a chat_files row and the chat_usage row(s) that produced it"):
      // every file this call writes is stamped with the turn's own correlation id, giving
      // Phase 12's per-file export an exact `chat_files.correlation_id = chat_usage.correlation_id`
      // join, rather than an approximate one inferred from timestamps.
      tools: {
        writeMarkdown: createWriteMarkdownTool({
          bucket: this.env.FILES,
          database: this.env.DB,
          chatId: this.name,
          correlationId,
        }),
      },
      // See MAX_TURN_STEPS's own JSDoc: without this, a successful tool call would end the turn
      // with no assistant text acknowledging it, since streamText()'s own default stops after
      // exactly one step.
      stopWhen: stepCountIs(MAX_TURN_STEPS),
      onFinish: async (event) => {
        await onFinish(event);
        await this.recordTurnUsage(correlationId, event.usage);
        await this.afterTurnCompleted(model);
      },
    });

    return result.toUIMessageStreamResponse();
  }

  /**
   * Write this turn's immediately-available local cost/token estimate (docs/06-AGENTIC-CHAT.md
   * Section 6.6, Phase 6, US-5), push the refreshed running total to every connected client, and
   * schedule the first attempt to upgrade it to AI Gateway's own authoritative figure. Called
   * only from `onChatMessage()`'s `onFinish` wrapper -- a turn that never reaches `onFinish`
   * (aborted, errored before first token) correctly never calls this at all, so it can never
   * write a row or push a stale total for a turn the client never saw complete.
   *
   * Best-effort and independently guarded, matching {@link afterTurnCompleted}'s own resilience
   * principle: the model's answer has already fully streamed back to the client by the time
   * this runs, so a D1/scheduling failure here must never surface as a failed turn.
   *
   * @param correlationId This turn's correlation id, minted by `onChatMessage()` before the
   * model call.
   * @param usage `streamText()`'s own reported token usage for the completed turn.
   */
  private async recordTurnUsage(
    correlationId: string,
    usage: LanguageModelUsage,
  ): Promise<void> {
    const chatId = this.name;
    const repository = new UsageRepository(this.env.DB);
    // Mirrors the same business-tier resolution AI Gateway's own conditional node applies
    // (docs/06-AGENTIC-CHAT.md Phase 8, US-7) so this immediate local estimate is priced
    // against the model the route actually resolves to for this caller, not always the
    // "field"-tier model -- see `modelIdForRoute()`'s own JSDoc for the caveat that this is a
    // snapshot of the routes' current configuration, not a live lookup.
    const model = modelIdForRoute(this.route, this.business);
    // `inputTokens`/`outputTokens` are typed `number | undefined` by the `ai` SDK itself (some
    // providers never report usage at all) -- `workers-ai-provider` always synthesizes a
    // numeric value for this demo's own fake/real models, so this fallback is defensive against
    // a provider that does not, not something this demo's own test fixtures can force `??` to
    // actually branch on.
    const promptTokens = usage.inputTokens ?? 0;
    const completionTokens = usage.outputTokens ?? 0;
    const costUsd = estimateCostUsd(model, promptTokens, completionTokens);

    try {
      const row = await repository.insertEstimated({
        chatId,
        model,
        promptTokens,
        completionTokens,
        costUsd,
        correlationId,
      });
      await this.refreshUsageState();
      await this.schedule<ReconcileUsagePayload>(
        INITIAL_RECONCILE_DELAY_SECONDS,
        "reconcileUsage",
        { chatUsageId: row.id, correlationId },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "usage_record_failed",
          chatId,
          correlationId,
          error: String(error),
        }),
      );
    }
  }

  /**
   * Re-aggregate this chat's own `chat_usage` rows and push the fresh total via `setState()`
   * (docs/06-AGENTIC-CHAT.md Section 6.6a). Called after every write to the ledger --
   * {@link recordTurnUsage}'s initial insert and {@link reconcileUsage}'s successful upgrade --
   * so `state.usage` is always derived from D1, never independently incremented in two places.
   * `setState()` is a full state replacement (Spike A), so this always passes a complete
   * {@link ChatAgentState}.
   */
  private async refreshUsageState(): Promise<void> {
    const summary = await new UsageRepository(this.env.DB).aggregateForChat(
      this.name,
    );
    this.setState({ usage: summary });
  }

  /**
   * Agents SDK scheduled-task handler (docs/06-AGENTIC-CHAT.md Section 6.6): looks for this
   * turn's real AI Gateway log row by correlation id and, once found, upgrades the `chat_usage`
   * row in place from `"estimated"` to `"gateway"`. Covers a failed-but-logged turn identically
   * to a successful one (Spike F: a failed dynamic-route call still produces its own
   * correlatable log row) -- no special case is needed for that path.
   *
   * A REST-call failure (network, credentials) is logged distinctly from a genuinely empty
   * result, but both fall through to the same bounded-retry path below: neither should ever
   * throw out of a scheduled task, since a scheduled-task exception has no request to surface
   * to and would otherwise leave this turn's ledger row stuck mid-reconciliation.
   *
   * @param payload The `chat_usage` row and correlation id to reconcile, from
   * {@link recordTurnUsage}'s initial schedule call or a prior attempt's own backoff reschedule.
   */
  async reconcileUsage(payload: ReconcileUsagePayload): Promise<void> {
    const repository = new UsageRepository(this.env.DB);

    let match: Awaited<ReturnType<typeof findLogByCorrelationId>> = null;
    try {
      match = await findLogByCorrelationId(payload.correlationId, {
        accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
        gatewayId: this.env.AI_GATEWAY_ID,
        apiToken: this.env.CLOUDFLARE_API_TOKEN,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "usage_reconcile_lookup_failed",
          chatUsageId: payload.chatUsageId,
          correlationId: payload.correlationId,
          error: String(error),
        }),
      );
    }

    if (match !== null) {
      const updated = await repository.reconcileWithGatewayLog(
        payload.correlationId,
        match,
      );
      // `updated === false` means the row (or the whole chat) disappeared between scheduling
      // and this task running (docs/06-AGENTIC-CHAT.md Section 11) -- exit cleanly, no
      // broadcast to a target that no longer exists.
      if (updated) {
        await this.refreshUsageState();
        this.broadcast(
          JSON.stringify({
            type: "usage_reconciled",
            chatUsageId: payload.chatUsageId,
            costSource: "gateway",
          } satisfies UsageReconciledFrame),
        );
      }
      return;
    }

    const attempts = await repository.incrementReconcileAttempts(
      payload.correlationId,
    );
    if (attempts === null) {
      // Section 11: the row's target has disappeared -- exit cleanly, not an error.
      return;
    }
    if (attempts >= MAX_RECONCILE_ATTEMPTS) {
      this.broadcast(
        JSON.stringify({
          type: "usage_reconcile_exhausted",
          chatUsageId: payload.chatUsageId,
        } satisfies UsageReconcileExhaustedFrame),
      );
      return;
    }
    await this.schedule<ReconcileUsagePayload>(
      RECONCILE_BACKOFF_SECONDS,
      "reconcileUsage",
      payload,
    );
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
