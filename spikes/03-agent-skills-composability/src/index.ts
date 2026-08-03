/**
 * @file Spike D — whether the Agents SDK's released Agent Skills mechanism (`agents/skills`'s
 * `SkillRegistry` + `r2()` source, `activate_skill`/`read_skill_resource` tools) can be attached
 * to an `AIChatAgent`-based chat's own `streamText()` call, rather than being usable only through
 * `@cloudflare/think`'s `Think` class.
 *
 * This is disposable spike code (docs/06-AGENTIC-CHAT.md, Section 8) — it answers one question
 * against the real account and is exempt from the demo contract in AGENTS.md. See README.md for
 * the exact aim and REPORT.md for what running it actually showed, including a real load-ordering
 * bug this spike hit and fixed (`onChatMessage`'s JSDoc below).
 */
import { AIChatAgent } from "@cloudflare/ai-chat";
import { getAgentByName } from "agents";
import { r2, SkillRegistry } from "agents/skills";
import { convertToModelMessages, stepCountIs, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

/**
 * A Workers AI model documented with **multi-turn** tool-calling support, confirmed compatible
 * with the Vercel AI SDK by Cloudflare's own GLM-4.7-Flash announcement, and already used in
 * `demos/ai-chat`'s catalog (docs/05-AI-CHAT.md) for its `reasoning-field` mechanism. See
 * REPORT.md for why this is not `llama-3.3-70b-instruct-fp8-fast` (deprecated mid-spike, see
 * below) or `hermes-2-pro-mistral-7b` (deprecated 2026-05-30) — and why the model choice turned
 * out not to be load-bearing for this spike's actual finding anyway.
 */
export const SPIKE_MODEL_ID = "@cf/zai-org/glm-4.7-flash";

/** The Worker's declared bindings, matching `wrangler.jsonc`. Regenerate with `wrangler types`. */
interface Env {
  CHAT_AGENT: DurableObjectNamespace<ChatAgent>;
  AI: Ai;
  /** Backs the skill catalog — `agents/skills`'s `r2()` source takes a plain `R2Bucket`. */
  SKILLS: R2Bucket;
}

/**
 * Props threaded into a `ChatAgent` instance by `getAgentByName()` at routing time — stands in
 * for a Cloudflare Access-verified identity exactly as Spike A's `ChatAgentProps` does. Spike D
 * reuses that pattern verbatim; the identity itself is incidental to this spike's question.
 */
interface ChatAgentProps extends Record<string, unknown> {
  ownerEmail: string;
}

/**
 * Minimal `AIChatAgent` subclass proving Agent Skills compose with it directly. One Durable
 * Object instance per chat name (Section 6.2), backed by a single R2-sourced skill catalog.
 */
export class ChatAgent extends AIChatAgent<Env, unknown, ChatAgentProps> {
  /** Captured from `props` on first start; never trusted from a client-supplied field. */
  private ownerEmail: string | undefined;

  /**
   * Constructed lazily, once per Durable Object wake, and reused across turns. `r2()`'s own
   * `SkillSource` already caches its R2 listing in memory (`refreshIntervalMs`, default 60s;
   * see `agents/skills`'s source) — recreating it every call would not change correctness, only
   * discard that cache for no reason.
   */
  private skillRegistry: SkillRegistry | undefined;

  override async onStart(props?: ChatAgentProps): Promise<void> {
    this.ownerEmail = props?.ownerEmail;
  }

  /** The single R2-backed skill source this spike proves against (Spike D's aim). */
  private getSkillRegistry(): SkillRegistry {
    this.skillRegistry ??= new SkillRegistry([r2(this.env.SKILLS, { prefix: "skills/" })]);
    return this.skillRegistry;
  }

  /**
   * Handles an incoming chat turn — the same single-`streamText()`-call shape as Spike A's own
   * `onChatMessage`, with the skill catalog folded into `system` and `SkillRegistry.tools()`
   * passed straight through as `tools`. No adapter code, no forced `toolChoice`, no multi-phase
   * workaround: once REPORT.md §7's load-ordering bug (below) is fixed, this naive shape works.
   *
   * **The one non-obvious requirement (REPORT.md §7, a real bug this spike hit and fixed):**
   * `registry.tools()` reads the registry's already-loaded skill list **synchronously** — it does
   * not itself call `.load()` or await anything. Calling it concurrently with
   * `registry.systemPrompt()` (for example via `Promise.all([registry.systemPrompt(),
   * registry.tools()])`, which this spike's code first did) races `.tools()` against the
   * `.load()` that `.systemPrompt()` triggers internally: `.tools()` can run *before* `.load()`
   * has populated the registry's descriptor map, silently returning `{}` — no error, no warning.
   * The model then receives a system prompt correctly describing a skill and instructing it to
   * call `activate_skill`, but no such tool is actually bound, so it does the only thing it can:
   * narrate the tool call as plain text instead of invoking it. `registry.systemPrompt()` MUST be
   * awaited to completion *before* `registry.tools()` is called, not merely awaited alongside it.
   */
  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
    options?: Parameters<AIChatAgent<Env>["onChatMessage"]>[1],
  ) {
    const registry = this.getSkillRegistry();
    // Sequential, not `Promise.all([...])` — see this method's own JSDoc for why concurrent
    // resolution here silently drops every skill tool.
    const catalogPrompt = await registry.systemPrompt();
    const skillTools = registry.tools();

    const workersai = createWorkersAI({ binding: this.env.AI });

    const system = [
      `You are a terse test assistant. The signed-in owner of this chat is ${
        this.ownerEmail ?? "unknown"
      }. Keep every non-skill answer under 40 words.`,
      catalogPrompt,
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");

    const result = streamText({
      model: workersai(SPIKE_MODEL_ID, { gateway: { id: "default" } }),
      system,
      messages: await convertToModelMessages(this.messages),
      tools: skillTools,
      // Answering a skill-matched question takes at least three model turns here:
      // activate_skill -> read_skill_resource -> final text answer. `ai`@7's default `stopWhen`
      // (one step) would truncate the loop after the first tool call.
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal,
      onFinish,
    });

    return result.toUIMessageStreamResponse({
      // Surfaced verbatim for this spike's own debugging; a real demo's default `onError`
      // deliberately swallows the raw message before it reaches the client.
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

    // Same custom routing as Spike A (Section 9): a chat ID extracted from the path, not
    // `routeAgentRequest()`'s default convention — this spike's job is the skills question, not
    // routing, so it reuses that finding verbatim rather than re-deciding it.
    const match = url.pathname.match(/^\/chat\/([^/]+)$/);
    if (!match) {
      return new Response("Not found. Use /chat/<chat-id>", { status: 404 });
    }
    const chatId = match[1];

    // Stand-in for a Cloudflare Access-verified identity — never a field the client controls in
    // the real demo (see `ChatAgentProps`' JSDoc).
    const ownerEmail = request.headers.get("X-Spike-Owner") ?? "spike@example.com";

    const stub = await getAgentByName<Env, ChatAgent, ChatAgentProps>(env.CHAT_AGENT, chatId, {
      props: { ownerEmail },
    });
    return stub.fetch(request);
  },
};
