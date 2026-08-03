/**
 * @file Spike A — the minimal working chain: an `AIChatAgent` subclass, one Durable Object per
 * chat name, `onChatMessage` calling the `ai` SDK's `streamText()` with `workers-ai-provider`,
 * a model routed through an AI Gateway binding, streamed to a client over WebSocket.
 *
 * This is disposable spike code (docs/06-AGENTIC-CHAT.md, Section 8) — it answers one question
 * against the real account and is exempt from the demo contract in AGENTS.md. See README.md for
 * the exact aim and REPORT.md for what running it actually showed.
 */
import { AIChatAgent } from "@cloudflare/ai-chat";
import { getAgentByName, type Connection, type ConnectionContext } from "agents";
import { convertToModelMessages, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

/**
 * The two catalog models Spike A drives through the same code path, chosen to match
 * `demos/ai-chat/src/models.ts`'s verified catalog: one non-reasoning model and one model whose
 * reasoning surfaces inline via `<think>` tags at the raw Workers AI layer (see REPORT.md for
 * whether `workers-ai-provider` still exposes that as inline text or lifts it to a distinct
 * `ai` SDK reasoning message part).
 */
export const SPIKE_MODEL_IDS = {
  nonReasoning: "@cf/ibm-granite/granite-4.0-h-micro",
  reasoning: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
} as const;

/** The Worker's declared bindings, matching `wrangler.jsonc`. Regenerate with `wrangler types`. */
interface Env {
  CHAT_AGENT: DurableObjectNamespace<ChatAgent>;
  AI: Ai;
}

/**
 * Props threaded into a `ChatAgent` instance by `getAgentByName()` at routing time (delivered to
 * `onStart()` and, per the installed `partyserver` source, over an internal `x-partykit-props`
 * header on the routed request — never a field the client's message body can set). Stands in for
 * a Cloudflare Access-verified identity: the Worker extracts this from `Cf-Access-Jwt-Assertion`
 * in the real demo, never from a client-supplied field. Spike A instead reads it from a plain
 * `X-Spike-Owner` header (see README.md) since this spike deploys no Access application.
 */
interface ChatAgentProps extends Record<string, unknown> {
  ownerEmail: string;
}

/**
 * Minimal `AIChatAgent` subclass proving the chain end to end. One Durable Object instance per
 * chat name (Section 6.2), holding a resumable, persisted conversation.
 */
export class ChatAgent extends AIChatAgent<Env, unknown, ChatAgentProps> {
  /** Captured from `props` on first start; never trusted from a client-supplied field. */
  private ownerEmail: string | undefined;

  /** Set from `onConnect()`'s own `ctx.request.url` — see that method's JSDoc for why. */
  private modelIdOverride: string | undefined;

  /**
   * `partyserver`'s `Server.onStart()` lifecycle hook. Called once per wake with the `props`
   * passed to `getAgentByName()` at routing time — this is how a verified identity reaches the
   * Durable Object without the client ever supplying it directly.
   */
  override async onStart(props?: ChatAgentProps): Promise<void> {
    this.ownerEmail = props?.ownerEmail;
  }

  /**
   * `partyserver`'s `Server.onConnect()` lifecycle hook. Runs inside the real Durable Object
   * instance (unlike a property write through the `DurableObjectStub` returned by
   * `getAgentByName()`, which is an RPC boundary and does not persist arbitrary field
   * assignments back into the instance), so this is the correct place to read the connecting
   * request's own URL — spike-only plumbing letting one probe run compare two catalog models
   * over the same code path.
   */
  override async onConnect(
    _connection: Connection,
    ctx: ConnectionContext,
  ): Promise<void> {
    const modelParam = new URL(ctx.request.url).searchParams.get("model");
    this.modelIdOverride =
      modelParam === "reasoning" ? SPIKE_MODEL_IDS.reasoning : SPIKE_MODEL_IDS.nonReasoning;
  }

  /**
   * Handles an incoming chat turn. The model routed through is chosen by the request's `model`
   * query parameter (Spike A only — the real demo would resolve an AI Gateway dynamic route
   * name instead of a literal model ID, Section 6.3) captured on the connecting request's URL,
   * since `AIChatAgent`'s public API does not thread the original HTTP request into
   * `onChatMessage`. Falls back to the non-reasoning catalog entry.
   */
  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
    options?: Parameters<AIChatAgent<Env>["onChatMessage"]>[1],
  ) {
    const modelId = this.modelIdOverride ?? SPIKE_MODEL_IDS.nonReasoning;
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      // AI Gateway binding option (Section 6.3): the client/browser never sees this literal
      // model ID in the real demo — only a governed route name — but Spike A's job is to prove
      // the mechanical chain, not the routing UX, so the model ID is passed directly here.
      model: workersai(modelId, {
        gateway: { id: "spike-00-aichatagent-basics" },
      }),
      system: `You are a terse test assistant. The signed-in owner of this chat is ${
        this.ownerEmail ?? "unknown"
      }. Keep every answer under 40 words.`,
      messages: await convertToModelMessages(this.messages),
      abortSignal: options?.abortSignal,
      onFinish,
    });

    return result.toUIMessageStreamResponse({
      // `ai`'s default `onError` swallows the real message ("An error occurred.") so it never
      // leaks to the client — correct for a real demo, but this spike needs the raw message
      // while proving the chain out, so it's both logged (workers logs / `wrangler tail`) and
      // surfaced verbatim in the stream.
      onError: (error) => {
        console.error("[spike] streamText error", error);
        return error instanceof Error ? error.message : String(error);
      },
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Custom routing (Section 9, Spike A's aim): the backlog requires per-chat, not per-user,
    // instancing, so this spike calls `getAgentByName()` directly against a chat ID extracted
    // from the path, rather than relying on `routeAgentRequest()`'s default
    // `/agents/{kebab-class}/{name}` convention. The chat ID is the *second* path segment
    // (`/chat/<chatId>`); the demo's real chat-ownership check (a D1 lookup confirming
    // `chats.owner_email` matches the verified Access identity before ever calling
    // `getAgentByName`) is out of scope for this mechanical spike.
    const match = url.pathname.match(/^\/chat\/([^/]+)$/);
    if (!match) {
      return new Response("Not found. Use /chat/<chat-id>?model=reasoning|non-reasoning", {
        status: 404,
      });
    }
    const chatId = match[1];

    // Stand-in for a Cloudflare Access-verified identity (see ChatAgentProps' JSDoc). Never a
    // field the client controls in the real demo.
    const ownerEmail = request.headers.get("X-Spike-Owner") ?? "spike@example.com";

    const stub = await getAgentByName<Env, ChatAgent, ChatAgentProps>(
      env.CHAT_AGENT,
      chatId,
      { props: { ownerEmail } },
    );
    return stub.fetch(request);
  },
};
