import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  type GenerateTextOnFinishCallback,
  streamText,
  type ToolSet,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";

/**
 * Phase 2's hard-coded model, called directly (not through an AI Gateway dynamic route) via the
 * already-provisioned `cloudflare_ai_gateway.demo` gateway (Phase 1's Terraform). This proves the
 * `AIChatAgent` + `streamText()` + AI Gateway mechanism with the simplest possible model wiring
 * (docs/06-AGENTIC-CHAT.md, Phase 2, step 2); Phase 4 replaces this literal model ID with a
 * client-selected `"basic"`/`"reasoning"` AI Gateway dynamic route name (Section 6.3) -- the two
 * dynamic routes Terraform already provisions are deliberately unused until then. Reuses demo
 * 5's verified non-reasoning catalog entry (`docs/05-AI-CHAT.md`), which Spike A confirmed works
 * end to end through this exact `workers-ai-provider` + `AIChatAgent` chain.
 */
const PHASE_2_CHAT_MODEL_ID = "@cf/ibm-granite/granite-4.0-h-micro";

/**
 * Props threaded into a `ChatAgent` instance by `getAgentByName()` at routing time (delivered to
 * `onStart()`, per Spike A's confirmed mechanism -- never a field the client's own message body
 * can set). The Worker's routing layer (`src/worker/routes/chats.ts`) extracts this from the
 * Cloudflare Access-verified identity, after confirming that identity owns the D1 `chats` row
 * for this chat ID.
 */
export interface ChatAgentProps extends Record<string, unknown> {
  /** Verified Cloudflare Access identity that owns this chat. */
  ownerEmail: string;
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

  /**
   * `partyserver`'s `Server.onStart()` lifecycle hook, called once per wake with the `props`
   * passed to `getAgentByName()` at routing time (Spike A, Section 7) -- this is how the
   * Cloudflare Access-verified owner identity reaches this Durable Object without the client
   * ever supplying it directly.
   */
  override async onStart(props?: ChatAgentProps): Promise<void> {
    this.ownerEmail = props?.ownerEmail;
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
   * `streamText()` so the framework can persist the finished assistant message. Phase 6 adds a
   * cost-ledger `onFinish` wrapper around this same call site.
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

    const result = streamText({
      // Direct AI Gateway binding (Section 6.3): the already-provisioned gateway from Phase 1's
      // Terraform, not yet one of its two dynamic routes -- see PHASE_2_CHAT_MODEL_ID above.
      model: workersai(PHASE_2_CHAT_MODEL_ID, {
        gateway: { id: this.env.AI_GATEWAY_ID },
      }),
      system:
        `You are a helpful assistant embedded in a private, authenticated chat for ` +
        `${this.ownerEmail ?? "the signed-in user"}. Answer directly and concisely.`,
      messages: await convertToModelMessages(this.messages),
      abortSignal: options?.abortSignal,
      onFinish,
    });

    return result.toUIMessageStreamResponse();
  }
}
