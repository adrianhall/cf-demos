import {
  applyGraphOperation,
  type GraphOperation,
} from "../../graph-mutations";
import type { GraphData } from "../diagrams/types";
import { buildCatalogPromptContext } from "./catalog-context";
import {
  searchCloudflareDocumentationSafe,
  type DocumentationSearchOutcome,
} from "./docs-client";
import { dispatchToolCall, TOOL_DEFINITIONS } from "./tools";

/**
 * `src/worker/ai/chat-engine.ts` implements docs/09D-ARCHITECT-AICHAT.md's "Chat Loop And Tool
 * Execution" -- the bounded, model-driven tool-calling loop behind one AI chat turn. This module
 * is deliberately pure of `DiagramSession`/D1/WebSocket knowledge: it only knows "here is a
 * function that applies one operation and tells me whether it succeeded" ({@link ApplyMutationFn}),
 * "here is a function that renames the diagram" ({@link RenameDiagramFn}), and a handful of
 * narrow status/token/docs-lookup callbacks -- so it is unit-testable against a fixture Workers
 * AI double with no Durable Object, D1, or real network call anywhere in its own test file,
 * exactly like `../../graph-mutations.ts` and `./tools.ts` already are.
 *
 * **Not the full generated `Ai` binding type.** `AI_CHAT_MODEL`
 * (`@cf/zai-org/glm-5.2`, docs/DECISIONS.md #35) is not yet a literal key of the generated
 * `AiModelList`, so a real call through the platform's own `Ai.run()` overloads always resolves
 * to its "unknown model" fallback overload (`Record<string, unknown>` in, `Record<string,
 * unknown>` out) regardless of the `stream` flag -- the *runtime* binding still honors `stream`
 * correctly (confirmed by this repository's own Workers AI streaming precedent,
 * docs/DECISIONS.md #9-11), only the compile-time overload resolution cannot express it for this
 * specific model id. {@link ChatAiBinding} below is this module's own narrower, honest
 * description of the binding's actual runtime contract for a tool-calling chat call, confirmed
 * against
 * https://developers.cloudflare.com/workers-ai/function-calling/ and
 * https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/ -- callers
 * (`../diagram-session/diagram-session.ts`) pass `this.env.AI` cast to this interface at the one
 * call site, with that cast's justification documented there.
 */

/** One message in the plain conversational history a `DiagramSession` connection keeps between
 * chat turns (docs/09D-ARCHITECT-AICHAT.md's Chat Loop And Tool Execution: "the plain
 * conversational text exchanged so far on this connection"). Deliberately only `user`/
 * `assistant` -- the turn-local `system`/`tool`/tool-call-echoing `assistant` messages this
 * module also sends to the model never join this persisted-per-connection shape; see
 * {@link RunDiagramChatTurnResult}. */
export interface ChatMessage {
  /** Who said it. */
  role: "user" | "assistant";
  /** Plain message text. */
  content: string;
}

/** One tool call as Workers AI's own non-streaming `tool_calls[]` output reports it -- `name`/
 * `arguments` (an already-parsed object, not a JSON string; confirmed by Cloudflare's own worked
 * example directly accessing `selected_tool.arguments.username`), not the newer OpenAI-style
 * `{ id, type, function: { name, arguments } }` shape the generated `AiTextGenerationToolOutput`
 * type also allows for a different model family. */
export interface AiToolCall {
  /** Tool name, matching one of {@link TOOL_DEFINITIONS}'s own `name` values. */
  name: string;
  /** Already-parsed tool call arguments. */
  arguments: Record<string, unknown>;
}

/** The non-streaming shape a tool-calling `env.AI.run()` call resolves to. */
export interface AiChatRunResult {
  /** The model's natural-language response for this round. Present even when `tool_calls` is
   * also present on some models; this module never relies on it when `tool_calls` is non-empty. */
  response?: string;
  /** Present when the model chose to call one or more tools this round; absent/empty once the
   * model is done calling tools and is producing its final answer. */
  tool_calls?: AiToolCall[];
}

/** One plain, role-scoped chat message, exactly the shape `env.AI.run()`'s `messages` input
 * expects (`RoleScopedChatInput` in the generated binding types) -- kept as this module's own
 * narrow interface rather than importing the generated type, since this module also constructs
 * `role: "tool"` messages the generated type's own `role` union already permits but this
 * module's own {@link ChatMessage} (persisted history) deliberately does not. */
interface RoleScopedMessage {
  role: string;
  content: string;
}

/**
 * The narrow slice of the real `Ai` binding this module actually calls -- see this file's own
 * top-of-file JSDoc for why the full generated `Ai` class cannot express this module's calls
 * precisely for `AI_CHAT_MODEL`'s current model id.
 */
export interface ChatAiBinding {
  /**
   * @param model Workers AI model id (`AI_CHAT_MODEL`).
   * @param inputs Chat messages, optional tools, and optional `stream: true`.
   * @param options AI Gateway routing options.
   * @returns A parsed {@link AiChatRunResult} for a non-streaming call, or a `ReadableStream` of
   * SSE-framed bytes for a `stream: true` call.
   */
  run(
    model: string,
    inputs: {
      messages: RoleScopedMessage[];
      tools?: typeof TOOL_DEFINITIONS;
      stream?: boolean;
    },
    options: { gateway: { id: string } },
  ): Promise<AiChatRunResult | ReadableStream<Uint8Array>>;
}

/** The narrow environment slice {@link runDiagramChatTurn} needs -- deliberately not the full
 * `Env`, for the same "no DiagramSession/D1/WebSocket dependency" purity this module's other
 * Phase 22 siblings (`./tools.ts`, `./catalog-context.ts`) already have. */
export interface DiagramChatAiEnv {
  /** The Workers AI binding, narrowed to {@link ChatAiBinding}. */
  AI: ChatAiBinding;
  /** AI Gateway id every call is routed through (`wrangler.jsonc.tpl`'s `AI_GATEWAY_ID`). */
  AI_GATEWAY_ID: string;
  /** Workers AI model id every call uses (`wrangler.jsonc.tpl`'s `AI_CHAT_MODEL`). */
  AI_CHAT_MODEL: string;
}

/** Result of the caller's `applyMutation` callback for one graph-mutating tool call. */
export interface ApplyMutationResult {
  /** Whether the underlying `DiagramSession.applyOperation()` call was rejected (a stale-target
   * `notFound()`, e.g. a concurrent human or MCP-agent edit already removed the target). */
  rejected: boolean;
  /** Human/model-readable rejection reason, present when `rejected` is `true`. */
  reason?: string;
}

/**
 * Applies one graph-mutating tool call's translated {@link GraphOperation} and reports whether it
 * succeeded -- the one seam between this module and `DiagramSession`'s own
 * `applyOperation()` RPC. Must never throw for an ordinary rejection (a stale-target
 * `notFound()`); the caller is expected to catch that itself and resolve `{ rejected: true,
 * reason }` instead (docs/09D-ARCHITECT-AICHAT.md's Chat Loop And Tool Execution). A genuinely
 * unexpected thrown error is allowed to propagate -- see {@link runDiagramChatTurn}'s own
 * `@throws`.
 *
 * @param op The operation to apply.
 * @returns Whether the operation was rejected.
 */
export type ApplyMutationFn = (
  op: GraphOperation,
) => Promise<ApplyMutationResult>;

/**
 * Renames the diagram and/or changes its description for one `rename_diagram` tool call. Must
 * never throw for an ordinary "diagram not found" case in practice (the caller already knows the
 * diagram exists, since it is the same one this Durable Object is hydrated for) -- any thrown
 * error is allowed to propagate, per {@link runDiagramChatTurn}'s `@throws`.
 *
 * @param title New title, when the tool call provided one.
 * @param description New description (`null` clears it), when the tool call provided one.
 */
export type RenameDiagramFn = (
  title?: string,
  description?: string | null,
) => Promise<void>;

/**
 * Inputs to {@link runDiagramChatTurn}.
 */
export interface RunDiagramChatTurnInput {
  /** The narrow Workers AI environment slice (see {@link DiagramChatAiEnv}). */
  env: DiagramChatAiEnv;
  /** The diagram's current, authoritative graph -- read directly from `DiagramSession`'s own
   * already-hydrated `this.graph`, never re-fetched from D1 by this module. */
  graph: GraphData;
  /** The diagram's current title. */
  title: string;
  /** The diagram's current description, `null` when unset. */
  description: string | null;
  /** The connection's own prior conversational history, oldest first. Not mutated by this
   * function -- the caller is responsible for appending the resulting `{ role: "user" }`/
   * `{ role: "assistant" }` pair to its own persisted copy once this function returns. */
  messages: ChatMessage[];
  /** The user's new message text for this turn. */
  text: string;
  /** Applies one graph-mutating tool call (see {@link ApplyMutationFn}). */
  applyMutation: ApplyMutationFn;
  /** Applies one `rename_diagram` tool call (see {@link RenameDiagramFn}). */
  renameDiagram: RenameDiagramFn;
  /** Called synchronously with a short, human-readable progress narration ("Adding node…",
   * "Checking Cloudflare docs…") once per tool call, before it runs. The caller
   * (`DiagramSession`) turns each call into a unicast `chat_status` WebSocket frame. */
  onStatus: (message: string) => void;
  /** Called with each streamed chunk of the final answer's text, in order, as it arrives. The
   * caller turns each call into a unicast `chat_token` WebSocket frame. */
  onToken: (text: string) => void;
  /** Called once per `search_cloudflare_documentation` tool call with the query and its
   * outcome, so the caller can build the `chat_tool_result` WebSocket frame
   * (docs/09D-ARCHITECT-AICHAT.md's Message Protocol) -- kept separate from `onStatus` because
   * that frame carries structured `args`/`result`, not just a narration string. Optional so a
   * caller that does not need this frame (a future generation-only caller, for example) is not
   * forced to wire it. */
  onDocsLookup?: (query: string, outcome: DocumentationSearchOutcome) => void;
}

/**
 * Result of one completed chat turn -- enough for the caller to append the final user/assistant
 * pair to its own persisted history and to log `ai_chat_turn_completed`.
 */
export interface RunDiagramChatTurnResult {
  /** The model's final natural-language answer, assembled from the streamed final round. */
  assistantText: string;
  /** Total number of tool calls executed across every round of this turn (0 if the model never
   * called a tool). */
  toolCallCount: number;
  /** Whether at least one tool call in this turn actually changed the diagram (a successful
   * graph-mutating operation or a `rename_diagram` call) -- `false` for a purely explanatory
   * turn, or one whose only mutation attempts were all rejected. */
  mutated: boolean;
}

/** Hard cap on tool-calling rounds per turn (docs/09D-ARCHITECT-AICHAT.md's Chat Loop And Tool
 * Execution, step 3: "capped at 8 rounds"). */
const MAX_TOOL_ROUNDS = 8;

/** The synthetic tool result injected once the round cap is hit, telling the model to stop
 * calling tools and produce its final answer now. */
const ACTION_LIMIT_MESSAGE =
  "You have reached the action limit for this turn (8 tool calls). Provide your final answer now without calling any more tools.";

/**
 * Build the turn's system prompt: `./catalog-context.ts`'s live product catalog digest plus the
 * diagram's current title/description and a short statement of the assistant's role and scope
 * (docs/09D-ARCHITECT-AICHAT.md's Chat Loop And Tool Execution, step 1).
 *
 * @param title The diagram's current title.
 * @param description The diagram's current description, `null` when unset.
 * @returns The complete system prompt text.
 */
function buildSystemPrompt(title: string, description: string | null): string {
  return [
    "You are an AI assistant embedded in Cloudflare Architect, a diagram editor for designing " +
      "architectures built from real Cloudflare products. You can explain the diagram currently " +
      "on the canvas, and you can change it by calling the tools below. Only use product types " +
      "and edge types from the catalog listed below -- never invent one. Keep your natural- " +
      "language responses concise; let the tool calls speak for the diagram changes themselves.",
    `Current diagram title: ${title}`,
    `Current diagram description: ${description ?? "(none)"}`,
    buildCatalogPromptContext(),
  ].join("\n\n");
}

/**
 * Build a short, human-readable progress narration for one graph-mutating tool call, passed to
 * `onStatus` before the operation is applied (docs/09D-ARCHITECT-AICHAT.md's own examples:
 * "Adding node…", "Checking Cloudflare docs…").
 *
 * @param op The operation about to be applied.
 * @returns A short narration string.
 */
function narrateGraphOperation(op: GraphOperation): string {
  switch (op.kind) {
    case "add_node":
      return `Adding node "${op.input.label}"…`;
    case "update_node":
      return "Updating node…";
    case "remove_node":
      return "Removing node…";
    case "add_edge":
      return "Connecting nodes…";
    case "update_edge":
      return "Updating connection…";
    case "remove_edge":
      return "Removing connection…";
  }
}

/** Callbacks {@link executeToolCall} needs, a narrow subset of {@link RunDiagramChatTurnInput}. */
interface ToolExecutionContext {
  applyMutation: ApplyMutationFn;
  renameDiagram: RenameDiagramFn;
  onStatus: (message: string) => void;
  onDocsLookup?: (query: string, outcome: DocumentationSearchOutcome) => void;
}

/** Result of executing one tool call -- the text fed back to the model as this tool's `role:
 * "tool"` result, whether it mutated the diagram, and the turn-local graph copy to use for any
 * later tool call this same turn. */
interface ToolExecutionOutcome {
  resultText: string;
  mutatedNow: boolean;
  nextGraph: GraphData;
}

/**
 * Execute one tool call: validate/translate it via `./tools.ts`'s `dispatchToolCall()`, then run
 * the matching effect.
 *
 * For a graph-mutating tool call, `graph` (this module's own turn-local copy, captured once at
 * the start of the turn) can go stale mid-turn as `applyMutation` calls land against the real,
 * authoritative graph `DiagramSession` holds -- see `./tools.ts`'s own JSDoc on `dispatchToolCall`
 * for why that staleness is harmless for `add_node`'s default-position filling specifically (it
 * only affects a cosmetic default position, and docs/09D-ARCHITECT-AICHAT.md explicitly accepts
 * "a chat turn is not one atomic transaction"). This function still keeps its own local `graph`
 * copy in sync after each *successful* mutation (via `../../graph-mutations.ts`'s pure
 * `applyGraphOperation()`, mirroring what the real mutation would produce) so
 * `nextGridPosition()`'s node-count-based fallback stays sane across multiple `add_node` calls
 * within the same turn -- a deliberate, documented choice, not a live re-fetch of the real graph.
 *
 * @param toolCall The model's tool call.
 * @param graph This turn's current local graph copy.
 * @param ctx Callbacks needed to actually run the tool's effect.
 * @returns The tool's result text, whether it mutated the diagram, and the turn-local graph copy
 * to use for the next tool call this turn.
 */
async function executeToolCall(
  toolCall: AiToolCall,
  graph: GraphData,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutcome> {
  const dispatch = dispatchToolCall(toolCall.name, toolCall.arguments, graph);

  switch (dispatch.kind) {
    case "graph_operation": {
      ctx.onStatus(narrateGraphOperation(dispatch.operation));
      const applied = await ctx.applyMutation(dispatch.operation);
      if (applied.rejected) {
        return {
          mutatedNow: false,
          nextGraph: graph,
          resultText: applied.reason ?? "Operation rejected.",
        };
      }
      return {
        mutatedNow: true,
        nextGraph: applyGraphOperation(graph, dispatch.operation),
        resultText: "Operation applied.",
      };
    }

    case "rename_diagram": {
      ctx.onStatus("Renaming the diagram…");
      await ctx.renameDiagram(dispatch.title, dispatch.description);
      return {
        mutatedNow: true,
        nextGraph: graph,
        resultText: "Diagram renamed.",
      };
    }

    case "search_cloudflare_documentation": {
      ctx.onStatus(`Checking Cloudflare docs for "${dispatch.query}"…`);
      const startedAt = Date.now();
      const outcome = await searchCloudflareDocumentationSafe(dispatch.query);
      const latencyMs = Date.now() - startedAt;
      // Structured, machine-parseable console logging for `ai_docs_lookup_performed` --
      // deliberately plain `console.log()`, not the toolkit's `cloudflareLogger()`: that
      // middleware resolves a request-scoped logger off the Hono `Context`, which does not
      // exist inside this module (called from a Durable Object method, not a Hono route). Never
      // logs the query text or result snippets, per docs/09D-ARCHITECT-AICHAT.md's Cloudflare
      // Docs Tool section.
      console.log(
        JSON.stringify({
          event: "ai_docs_lookup_performed",
          latencyMs,
          resultCount: outcome.ok ? outcome.results.length : 0,
        }),
      );
      ctx.onDocsLookup?.(dispatch.query, outcome);
      return {
        mutatedNow: false,
        nextGraph: graph,
        resultText: outcome.ok
          ? JSON.stringify(outcome.results)
          : outcome.message,
      };
    }

    case "tool_error":
      return {
        mutatedNow: false,
        nextGraph: graph,
        resultText: dispatch.message,
      };
  }
}

/**
 * Run one non-streaming, tool-calling round.
 *
 * @param ai The narrowed Workers AI binding.
 * @param gatewayId AI Gateway id to route through.
 * @param model Workers AI model id.
 * @param messages The full message list for this round.
 * @returns The parsed, non-streaming result.
 * @throws {Error} If the binding unexpectedly returns a `ReadableStream` for a call that did not
 * request one.
 */
async function runNonStreamingRound(
  ai: ChatAiBinding,
  gatewayId: string,
  model: string,
  messages: RoleScopedMessage[],
): Promise<AiChatRunResult> {
  const result = await ai.run(
    model,
    { messages, tools: TOOL_DEFINITIONS },
    { gateway: { id: gatewayId } },
  );
  if (result instanceof ReadableStream) {
    throw new Error(
      "Expected a non-streaming Workers AI tool-calling response but received a stream.",
    );
  }
  return result;
}

/**
 * Extract this streamed chunk's text delta, tolerating either of the two chunk-shape families
 * this repository's own prior Workers AI streaming work found in the wild
 * (docs/DECISIONS.md #10): the "cf-native" `{ response }` shape, and the `openai-chat`-adapter
 * `{ choices: [{ delta: { content } }] }` shape. Checks the `choices` shape first, then falls
 * back to `response`, matching #10's own "choices-shape-first-then-response-fallback" rule.
 *
 * @param parsed One decoded JSON chunk payload.
 * @returns The chunk's text delta, or an empty string when neither shape yields one (a terminal
 * usage-only chunk, or a shape this function does not recognize).
 */
function extractStreamDelta(parsed: unknown): string {
  if (typeof parsed !== "object" || parsed === null) return "";
  const choices = (parsed as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const content = (
      choices[0] as { delta?: { content?: unknown } } | undefined
    )?.delta?.content;
    if (typeof content === "string") return content;
  }
  const response = (parsed as { response?: unknown }).response;
  return typeof response === "string" ? response : "";
}

/**
 * Consume a `ReadableStream` of SSE-framed bytes, calling `onToken` for each non-empty text
 * delta extracted from a well-formed `data: {...}` line. A line that fails to parse as JSON (a
 * partial/malformed chunk) is skipped rather than thrown, per docs/09D-ARCHITECT-AICHAT.md's own
 * instruction to "handle defensively" given this repository's prior confirmed finding that
 * Workers AI streaming chunk shapes diverge from declared types (docs/DECISIONS.md #10) -- one
 * malformed chunk must never abort the whole chat turn.
 *
 * @param stream The raw byte stream.
 * @param onToken Called once per non-empty text delta, in arrival order.
 * @returns The concatenation of every text delta seen.
 */
async function consumeSseStream(
  stream: ReadableStream<Uint8Array>,
  onToken: (text: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (payload.length === 0 || payload === "[DONE]") continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // Malformed/partial chunk -- skip it, never crash the turn over it.
        }

        const delta = extractStreamDelta(parsed);
        if (delta.length > 0) {
          assistantText += delta;
          onToken(delta);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return assistantText;
}

/**
 * Run the turn's final, non-tool-calling round with `stream: true`, relaying each streamed text
 * delta to `onToken`.
 *
 * @param ai The narrowed Workers AI binding.
 * @param gatewayId AI Gateway id to route through.
 * @param model Workers AI model id.
 * @param messages The full message list for the final round.
 * @param onToken Called once per streamed text delta.
 * @returns The assembled final answer text.
 */
async function runStreamingRound(
  ai: ChatAiBinding,
  gatewayId: string,
  model: string,
  messages: RoleScopedMessage[],
  onToken: (text: string) => void,
): Promise<string> {
  const result = await ai.run(
    model,
    { messages, stream: true },
    { gateway: { id: gatewayId } },
  );

  if (!(result instanceof ReadableStream)) {
    // Defensive: a test double or an unexpected non-streaming response for a `stream: true`
    // call is treated as a single, already-complete final answer rather than crashing the turn.
    const text = typeof result.response === "string" ? result.response : "";
    if (text.length > 0) onToken(text);
    return text;
  }

  return consumeSseStream(result, onToken);
}

/**
 * Run one full turn of docs/09D-ARCHITECT-AICHAT.md's Chat Loop And Tool Execution: a bounded,
 * model-driven tool-calling loop against Workers AI, followed by one streamed final answer.
 *
 * The loop, precisely:
 * 1. Build the system prompt from the diagram's current title/description and the live product
 *    catalog digest ({@link buildSystemPrompt}).
 * 2. Call `env.AI.run()` non-streaming, with every graph-mutating/`rename_diagram`/docs-search
 *    tool available.
 * 3. For each tool call the model makes, run its effect ({@link executeToolCall}) and append the
 *    call and its result to a turn-local message array (never the caller's persisted `messages`
 *    history) as `role: "assistant"`/`role: "tool"` messages, then return to step 2 -- capped at
 *    {@link MAX_TOOL_ROUNDS} rounds, after which one synthetic tool result tells the model it has
 *    reached its action limit for this turn.
 * 4. Once a round returns no tool calls (organically, or because the cap forced it), re-run that
 *    same round with `stream: true`, relaying every streamed text delta to `onToken`.
 * 5. Return the assembled final answer, the total tool-call count, and whether the turn mutated
 *    the diagram -- the caller is responsible for appending the final `{ role: "user" }`/
 *    `{ role: "assistant" }` pair to its own persisted history and for logging
 *    `ai_chat_turn_completed`.
 *
 * @param input See {@link RunDiagramChatTurnInput}.
 * @returns See {@link RunDiagramChatTurnResult}.
 * @throws {Error} On any unexpected/uncaught failure anywhere in the loop -- a malformed AI
 * response, a genuinely thrown error from `applyMutation`/`renameDiagram` that is not a normal
 * `{ rejected: true }` result, or an AI Gateway/binding-level failure. This function never
 * catches or swallows such an error; the caller (`DiagramSession`) is responsible for catching
 * it, sending a `chat_error` frame to the originating connection only, and logging
 * `ai_chat_turn_failed`.
 */
export async function runDiagramChatTurn(
  input: RunDiagramChatTurnInput,
): Promise<RunDiagramChatTurnResult> {
  const {
    env,
    graph: initialGraph,
    title,
    description,
    messages,
    text,
    applyMutation,
    renameDiagram,
    onStatus,
    onToken,
    onDocsLookup,
  } = input;

  let graph = initialGraph;
  let mutated = false;
  let toolCallCount = 0;

  const turnMessages: RoleScopedMessage[] = [
    { content: buildSystemPrompt(title, description), role: "system" },
    ...messages,
    { content: text, role: "user" },
  ];

  const toolContext: ToolExecutionContext = {
    applyMutation,
    onDocsLookup,
    onStatus,
    renameDiagram,
  };

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round += 1) {
    const result = await runNonStreamingRound(
      env.AI,
      env.AI_GATEWAY_ID,
      env.AI_CHAT_MODEL,
      turnMessages,
    );

    if (!result.tool_calls || result.tool_calls.length === 0) {
      // Organic completion: exit the loop without appending anything further. Step 4's final
      // streamed re-run below repeats this exact round rather than trusting `result.response`
      // as the final answer, per the design's own "re-run that same round only with stream:
      // true."
      break;
    }

    for (const toolCall of result.tool_calls) {
      toolCallCount += 1;
      turnMessages.push({
        content: JSON.stringify(toolCall),
        role: "assistant",
      });
      const outcome = await executeToolCall(toolCall, graph, toolContext);
      graph = outcome.nextGraph;
      if (outcome.mutatedNow) mutated = true;
      turnMessages.push({ content: outcome.resultText, role: "tool" });
    }

    if (round === MAX_TOOL_ROUNDS) {
      turnMessages.push({ content: ACTION_LIMIT_MESSAGE, role: "tool" });
    }
  }

  const assistantText = await runStreamingRound(
    env.AI,
    env.AI_GATEWAY_ID,
    env.AI_CHAT_MODEL,
    turnMessages,
    onToken,
  );

  return { assistantText, mutated, toolCallCount };
}
