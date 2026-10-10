import {
  applyGraphOperation,
  type GraphOperation,
} from "../../graph-mutations";
import type { GraphData } from "../diagrams/types";
import {
  buildCatalogPromptContext,
  buildGraphPromptContext,
} from "./catalog-context";
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
 * **Every round streams, and every round carries `tools`.** Both properties are load-bearing and
 * were established empirically against the real `AI_CHAT_MODEL` (docs/DECISIONS.md #42):
 *
 * - *Every round streams.* An earlier design ran each tool-calling round non-streaming and then
 *   re-ran the final, tool-call-free round a second time with `stream: true` purely to get
 *   tokens. That generated the entire final answer twice and billed for it twice. `@cf/zai-org/
 *   glm-5.2` streams `tool_calls` as ordinary OpenAI-style `choices[0].delta.tool_calls[]`
 *   fragments keyed by `index`, so {@link consumeSseStream} can assemble them itself and the
 *   whole loop needs exactly one inference call per round.
 * - *Every round carries `tools`.* {@link buildSystemPrompt} tells the model it can change the
 *   diagram by calling tools. `spikes/03-agent-skills-composability/REPORT.md` §7 already
 *   documented what happens when that same system prompt is reused for a call that omits
 *   `tools`: the model narrates tool calls as raw text instead. That is exactly the failure
 *   docs/ISSUE-5.md reported -- a transcript full of the model's own native `<tool_call>` markup
 *   and invented tool names -- so a tool-instructing system prompt must never be sent without
 *   the matching tool definitions.
 *
 * **Not the full generated `Ai` binding type.** `AI_CHAT_MODEL`
 * (`@cf/zai-org/glm-5.2`, docs/DECISIONS.md #35) is not a literal key of the generated
 * `AiModelList`, so a real call through the platform's own `Ai.run()` overloads always resolves
 * to its "unknown model" fallback overload (`Record<string, unknown>` in, `Record<string,
 * unknown>` out) regardless of the `stream` flag -- the *runtime* binding still honors `stream`
 * correctly (confirmed by this repository's own Workers AI streaming precedent,
 * docs/DECISIONS.md #9-11 and #37), only the compile-time overload resolution cannot express it
 * for this specific model id. {@link ChatAiBinding} below is this module's own narrower, honest
 * description of the binding's actual runtime contract for a tool-calling chat call, confirmed
 * against
 * https://developers.cloudflare.com/workers-ai/features/function-calling/ and
 * https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/ -- callers
 * (`../diagram-session/diagram-session.ts`) pass `this.env.AI` cast to this interface at the one
 * call site, with that cast's justification documented there.
 */

/** One message in the plain conversational history a `DiagramSession` connection keeps between
 * chat turns (docs/09D-ARCHITECT-AICHAT.md's Chat Loop And Tool Execution: "the plain
 * conversational text exchanged so far on this connection"). Deliberately only `user`/
 * `assistant` -- the turn-local `system`/`tool`/tool-call-carrying `assistant` messages this
 * module also sends to the model never join this persisted-per-connection shape; see
 * {@link RunDiagramChatTurnResult}. */
export interface ChatMessage {
  /** Who said it. */
  role: "user" | "assistant";
  /** Plain message text. */
  content: string;
}

/**
 * One tool call exactly as it travels on the wire in the OpenAI chat-completions shape Workers
 * AI's `openai-chat` adapter uses for `AI_CHAT_MODEL` -- both in a response
 * (`choices[0].message.tool_calls[]`) and, echoed back unchanged, in the follow-up request's own
 * `role: "assistant"` message.
 */
export interface WireToolCall {
  /** Provider-assigned correlation id. The matching `role: "tool"` result message must repeat it
   * verbatim in its own `tool_call_id`. */
  id: string;
  /** Always the literal `"function"` for every tool call this module handles. */
  type: "function";
  /** The called function's name and its JSON-encoded arguments. */
  function: {
    /** Tool name, matching one of {@link TOOL_DEFINITIONS}'s own `name` values. */
    name: string;
    /** Arguments as a JSON **string**, not an object -- the model emits them as text, in
     * fragments when streaming. */
    arguments: string;
  };
}

/**
 * One tool call, normalized by this module out of whichever wire shape the response actually
 * used, ready to hand to `./tools.ts`'s `dispatchToolCall()`.
 */
export interface AiToolCall {
  /** The wire correlation id, when the response carried one. Absent on the legacy
   * Cloudflare-native `tool_calls[]` shape, which has no ids at all; {@link toWireToolCall} then
   * synthesizes a positional one. */
  id?: string;
  /** Tool name, matching one of {@link TOOL_DEFINITIONS}'s own `name` values. */
  name: string;
  /** Parsed tool call arguments. Already an object on the legacy Cloudflare-native shape;
   * `JSON.parse`d from {@link WireToolCall.function}'s `arguments` text otherwise. Deliberately
   * `unknown` rather than `Record<string, unknown>`: when that text is not valid JSON it is
   * passed through verbatim as a string, so `./tools.ts`'s own zod validation reports it back to
   * the model as an ordinary `tool_error` result instead of this module throwing. */
  arguments: unknown;
}

/**
 * The non-streaming shape a tool-calling `env.AI.run()` call can resolve to. Both currently
 * known families are modeled, because this module must tolerate either:
 *
 * - The `openai-chat` adapter shape (`choices[0].message`), which is what `AI_CHAT_MODEL`
 *   actually returns -- confirmed live against the real model, docs/DECISIONS.md #42.
 * - The older Cloudflare-native flat shape (`{ response, tool_calls }`) documented by
 *   https://developers.cloudflare.com/workers-ai/features/function-calling/, still returned by
 *   other models in the catalog.
 */
export interface AiChatRunResult {
  /** Cloudflare-native final text. */
  response?: string;
  /** Cloudflare-native, already-parsed tool calls. */
  tool_calls?: AiToolCall[];
  /** OpenAI chat-completions choices. */
  choices?: {
    message?: {
      /** Final text, or `null`/absent on a round whose entire output was tool calls. */
      content?: string | null;
      /** Wire-shaped tool calls, or `null`/absent on a text-only round. */
      tool_calls?: WireToolCall[] | null;
    };
  }[];
}

/** One role-scoped chat message, in the shape `env.AI.run()`'s `messages` input expects. Kept as
 * this module's own narrow interface rather than importing the generated `RoleScopedChatInput`,
 * since this module also constructs the `role: "tool"`/`tool_call_id` and
 * `role: "assistant"`/`tool_calls` messages the OpenAI chat-completions protocol requires for a
 * multi-round tool-calling conversation -- fields the generated type does not carry. */
interface RoleScopedMessage {
  /** `"system"`, `"user"`, `"assistant"`, or `"tool"`. */
  role: string;
  /** Message text. `null` on an assistant message whose entire content was tool calls. */
  content: string | null;
  /** Present only on an assistant message echoing back the tool calls the model just made. */
  tool_calls?: WireToolCall[];
  /** Present only on a `role: "tool"` result message; must match the id of the tool call it
   * answers. */
  tool_call_id?: string;
}

/**
 * The narrow slice of the real `Ai` binding this module actually calls -- see this file's own
 * top-of-file JSDoc for why the full generated `Ai` class cannot express this module's calls
 * precisely for `AI_CHAT_MODEL`'s current model id.
 */
export interface ChatAiBinding {
  /**
   * @param model Workers AI model id (`AI_CHAT_MODEL`).
   * @param inputs Chat messages, the tool catalog, and `stream: true`.
   * @param options AI Gateway routing options.
   * @returns A `ReadableStream` of SSE-framed bytes for the ordinary `stream: true` call, or a
   * parsed {@link AiChatRunResult} for a binding/test double that ignores the `stream` flag.
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
  /** The **authoritative** graph after this operation, as `DiagramSession.applyOperation()`
   * itself returns it. Load-bearing on success: `add_node`/`add_edge` mint their ids with
   * `crypto.randomUUID()` inside `../../graph-mutations.ts`, so re-deriving the post-operation
   * graph locally would produce different ids than the ones that actually exist -- and the
   * model would then be told an id that targets nothing. Optional only so a caller with no
   * authoritative graph to hand back (a test double) still works, via the local-replay fallback
   * in {@link executeToolCall}. */
  graph?: GraphData;
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
  /** Called with each streamed chunk of the answer's text, in order, as it arrives. The caller
   * turns each call into a unicast `chat_token` WebSocket frame. The concatenation of every call
   * is exactly {@link RunDiagramChatTurnResult.assistantText}, so a client that replaces its
   * streamed text with that final value on `chat_done` never sees the answer change. */
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
  /** The model's natural-language answer: every text delta streamed across every round of this
   * turn, concatenated in arrival order. Byte-for-byte what `onToken` already relayed. */
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
 * Execution, step 3: "capped at 8 rounds"). One further round beyond this cap is always run, so
 * the model can turn {@link ACTION_LIMIT_MESSAGE} into a final answer. */
const MAX_TOOL_ROUNDS = 8;

/** The synthetic instruction injected once the round cap is hit, telling the model to stop
 * calling tools and produce its final answer now. Sent as a `system` message rather than a
 * `tool` result because the OpenAI chat-completions protocol requires every `role: "tool"`
 * message to answer a specific preceding `tool_call_id`, and this message answers none. */
const ACTION_LIMIT_MESSAGE =
  "You have reached the action limit for this turn (8 rounds of tool calls). Provide your final answer now without calling any more tools.";

/**
 * Build the turn's system prompt: `./catalog-context.ts`'s live product catalog digest, the
 * diagram's current title/description, a digest of what is actually on the canvas right now
 * (including every node and edge **id** a tool call can target), and a short statement of the
 * assistant's role and scope (docs/09D-ARCHITECT-AICHAT.md's Chat Loop And Tool Execution,
 * step 1).
 *
 * Rebuilt for every round, not once per turn: the graph digest goes stale the moment the round's
 * own `add_node` calls land, and a model still looking at the pre-round canvas cannot wire up
 * the nodes it just created.
 *
 * @param title The diagram's current title.
 * @param description The diagram's current description, `null` when unset.
 * @param graph The diagram's graph as of this round.
 * @returns The complete system prompt text.
 */
function buildSystemPrompt(
  title: string,
  description: string | null,
  graph: GraphData,
): string {
  return [
    "You are an AI assistant embedded in Cloudflare Architect, a diagram editor for designing " +
      "architectures built from real Cloudflare products. You can explain the diagram currently " +
      "on the canvas, and you can change it by calling the tools below. Only use product types " +
      "and edge types from the catalog listed below -- never invent one. Change the diagram by " +
      "actually calling a tool; never write a tool call out as text in your reply. Keep your " +
      "natural-language responses concise; let the tool calls speak for the diagram changes " +
      "themselves.",
    `Current diagram title: ${title}`,
    `Current diagram description: ${description ?? "(none)"}`,
    buildGraphPromptContext(graph),
    buildCatalogPromptContext(),
  ].join("\n\n");
}

/**
 * Build the `role: "tool"` result text for one successfully applied graph operation, naming the
 * id of anything it created.
 *
 * `add_node` and `add_edge` mint their ids server-side (`crypto.randomUUID()` in
 * `../../graph-mutations.ts`), so a bare "Operation applied." leaves the model with no way to
 * refer to what it just created. It then guesses -- passing a node's label as `add_edge`'s
 * `source`/`target` -- and every follow-up call is rejected (docs/DECISIONS.md #42). Handing the
 * real id straight back is what makes a multi-step "add these nodes, then wire them together"
 * turn possible at all.
 *
 * @param op The operation that was applied.
 * @param before The graph as it was before the operation.
 * @param after The authoritative graph after the operation.
 * @returns The tool result text to feed back to the model.
 */
function describeMutationResult(
  op: GraphOperation,
  before: GraphData,
  after: GraphData,
): string {
  if (op.kind === "add_node") {
    const id = findCreatedId(before.nodes, after.nodes);
    if (id !== undefined) {
      return `Operation applied. Created node id: ${id}. Use this exact id as source/target in add_edge, or as nodeId in update_node/remove_node.`;
    }
  }
  if (op.kind === "add_edge") {
    const id = findCreatedId(before.edges, after.edges);
    if (id !== undefined) return `Operation applied. Created edge id: ${id}.`;
  }
  return "Operation applied.";
}

/**
 * Find the id of the one entity present in `after` but not `before`.
 *
 * @param before The node or edge list as it was before the operation.
 * @param after The same list afterwards.
 * @returns The new entity's id, or `undefined` when nothing was added or its id is not a string.
 */
function findCreatedId(
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
): string | undefined {
  const known = new Set(before.map((entity) => entity.id));
  const created = after.find((entity) => !known.has(entity.id));
  const id = created?.id;
  return typeof id === "string" ? id : undefined;
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
      // Deliberately no `onStatus` here. A graph mutation already narrates itself to every
      // connected tab through the `operation_applied` broadcast the client turns into an
      // `"action"` transcript entry, so an extra status produced two lines per operation
      // ("Adding node "API"…" then "Added node: API"). Worse, a status emitted *here* is
      // emitted before `applyMutation` has run, so a rejected operation still announced itself
      // as done -- the transcript claimed edges had been connected that were never applied.
      // Only the tools below, which produce no broadcast of their own, narrate through
      // `onStatus`. See docs/DECISIONS.md #43.
      const applied = await ctx.applyMutation(dispatch.operation);
      if (applied.rejected) {
        return {
          mutatedNow: false,
          nextGraph: graph,
          resultText: applied.reason ?? "Operation rejected.",
        };
      }
      const nextGraph =
        applied.graph ?? applyGraphOperation(graph, dispatch.operation);
      return {
        mutatedNow: true,
        nextGraph,
        resultText: describeMutationResult(
          dispatch.operation,
          graph,
          nextGraph,
        ),
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
 * Append the structural closers a truncated JSON document is missing.
 *
 * This exists for a confirmed `AI_CHAT_MODEL` streaming defect (docs/DECISIONS.md #42): when a
 * tool call's arguments end with a nested object -- `add_node`'s optional `position` is the case
 * that hits this constantly -- the `}}` that should close both the nested object and the
 * argument object arrives on the wire as a **single** `}`. Every affected call is otherwise
 * complete and becomes valid JSON by appending exactly the closers its own brace/bracket stack
 * still has open, which is all this function ever does.
 *
 * Deliberately refuses to repair text that ends inside an unterminated string literal: that
 * means real content was lost mid-value, and inventing a closing quote would silently produce a
 * truncated node label rather than an honest tool error the model can retry.
 *
 * @param text Trimmed candidate JSON text that already failed to parse.
 * @returns The repaired text, or `null` when there is nothing safe to repair (balanced already,
 * mismatched closers, or truncated mid-string).
 */
function closeTruncatedJson(text: string): string | null {
  const open: string[] = [];
  let inString = false;
  let escaped = false;

  for (const character of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      open.push(character);
    } else if (character === "}" || character === "]") {
      const expected = character === "}" ? "{" : "[";
      // A mismatched or unmatched closer is genuine corruption, not truncation.
      if (open.pop() !== expected) return null;
    }
  }

  if (inString || open.length === 0) return null;
  let repaired = text;
  for (let index = open.length - 1; index >= 0; index -= 1) {
    repaired += open[index] === "{" ? "}" : "]";
  }
  return repaired;
}

/**
 * Parse one tool call's accumulated JSON `arguments` text, repairing a truncated document via
 * {@link closeTruncatedJson} before giving up.
 *
 * @param text The raw arguments text, possibly empty (a zero-argument tool call).
 * @returns The parsed value, `{}` for empty text, or the original text unchanged when it is
 * neither valid nor safely repairable JSON -- see {@link AiToolCall}'s `arguments` for why a
 * parse failure is deliberately not thrown here.
 */
function parseToolArguments(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to the truncation repair below.
  }
  const repaired = closeTruncatedJson(trimmed);
  if (repaired !== null) {
    try {
      return JSON.parse(repaired);
    } catch {
      // Fall through to returning the raw text.
    }
  }
  return trimmed;
}

/**
 * Normalize one response's wire-shaped tool calls into this module's own {@link AiToolCall}
 * shape, dropping any entry with no usable name.
 *
 * @param calls The wire-shaped tool calls from `choices[0].message.tool_calls`.
 * @returns Normalized tool calls, in order.
 */
function normalizeWireToolCalls(calls: WireToolCall[]): AiToolCall[] {
  return calls
    .filter((call) => typeof call?.function?.name === "string")
    .map((call) => ({
      arguments: parseToolArguments(call.function.arguments ?? ""),
      id: call.id,
      name: call.function.name,
    }));
}

/**
 * Read the tool calls out of a non-streaming response object, tolerating either known shape (see
 * {@link AiChatRunResult}). The `openai-chat` shape is checked first, matching
 * {@link extractStreamDelta}'s own "choices-shape-first-then-response-fallback" rule.
 *
 * @param result The non-streaming response object.
 * @returns Normalized tool calls, empty when the response carried none.
 */
function extractObjectToolCalls(result: AiChatRunResult): AiToolCall[] {
  const wire = result.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(wire) && wire.length > 0) {
    return normalizeWireToolCalls(wire);
  }
  return result.tool_calls ?? [];
}

/**
 * Read the natural-language text out of a non-streaming response object, tolerating either known
 * shape (see {@link AiChatRunResult}).
 *
 * @param result The non-streaming response object.
 * @returns The response text, or an empty string when the response carried none.
 */
function extractObjectText(result: AiChatRunResult): string {
  const content = result.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  return typeof result.response === "string" ? result.response : "";
}

/**
 * Extract this streamed chunk's text delta, tolerating either of the two chunk-shape families
 * this repository's own prior Workers AI streaming work found in the wild
 * (docs/DECISIONS.md #10): the "cf-native" `{ response }` shape, and the `openai-chat`-adapter
 * `{ choices: [{ delta: { content } }] }` shape. Checks the `choices` shape first, then falls
 * back to `response`, matching #10's own "choices-shape-first-then-response-fallback" rule.
 *
 * Reads only `delta.content`, never `delta.reasoning_content`: `AI_CHAT_MODEL` is a reasoning
 * model and streams its entire chain of thought in that separate field (199 reasoning deltas vs.
 * 69 content deltas on the probe recorded in docs/DECISIONS.md #42). Relaying it would stream
 * the model's private reasoning straight into the user's transcript.
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
 * Extract this streamed chunk's tool-call delta fragments.
 *
 * @param parsed One decoded JSON chunk payload.
 * @returns The chunk's `choices[0].delta.tool_calls` entries, or an empty array when it has none.
 */
function extractStreamToolCallDeltas(parsed: unknown): unknown[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const toolCalls = (
    choices[0] as { delta?: { tool_calls?: unknown } } | undefined
  )?.delta?.tool_calls;
  return Array.isArray(toolCalls) ? toolCalls : [];
}

/** One in-progress tool call being assembled from streamed fragments. */
interface ToolCallAccumulator {
  /** The correlation id, carried only on the fragment that opens the call. */
  id?: string;
  /** The tool name, likewise carried only on the opening fragment. */
  name: string;
  /** Every `function.arguments` fragment seen so far, concatenated. */
  argumentsText: string;
}

/**
 * Fold one chunk's tool-call fragments into the round's accumulators.
 *
 * Streamed tool calls arrive OpenAI-style and are keyed by `index`, not by position within the
 * chunk: the opening fragment for call `n` carries `{ index: n, id, function: { name,
 * arguments: "" } }` and every later fragment carries only `{ index: n, function: { arguments:
 * "<next piece of the JSON>" } }` with `id`/`name` explicitly `null` (verified against the real
 * model, docs/DECISIONS.md #42). A chunk may interleave fragments for several indices, so this
 * never assumes one call finishes before the next begins.
 *
 * @param deltas This chunk's raw tool-call fragments.
 * @param accumulators The round's accumulators, keyed by `index`, mutated in place.
 */
function accumulateToolCallDeltas(
  deltas: unknown[],
  accumulators: Map<number, ToolCallAccumulator>,
): void {
  for (const [position, delta] of deltas.entries()) {
    if (typeof delta !== "object" || delta === null) continue;
    const raw = delta as {
      index?: unknown;
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown } | null;
    };
    const index = typeof raw.index === "number" ? raw.index : position;
    const accumulator = accumulators.get(index) ?? {
      argumentsText: "",
      name: "",
    };
    if (typeof raw.id === "string" && raw.id.length > 0) {
      accumulator.id = raw.id;
    }
    const fn = raw.function;
    if (fn) {
      if (typeof fn.name === "string" && fn.name.length > 0) {
        accumulator.name = fn.name;
      }
      if (typeof fn.arguments === "string") {
        accumulator.argumentsText += fn.arguments;
      }
    }
    accumulators.set(index, accumulator);
  }
}

/** What one completed round of the loop produced. */
interface StreamedRound {
  /** Every text delta the round streamed, concatenated. */
  text: string;
  /** Every tool call the round made, in `index` order. */
  toolCalls: AiToolCall[];
}

/**
 * Consume a `ReadableStream` of SSE-framed bytes, calling `onToken` for each non-empty text
 * delta and assembling every streamed tool call from its fragments.
 *
 * A line that fails to parse as JSON (a partial/malformed chunk) is skipped rather than thrown,
 * per docs/09D-ARCHITECT-AICHAT.md's own instruction to "handle defensively" given this
 * repository's prior confirmed finding that Workers AI streaming chunk shapes diverge from
 * declared types (docs/DECISIONS.md #10) -- one malformed chunk must never abort the whole chat
 * turn.
 *
 * @param stream The raw byte stream.
 * @param onToken Called once per non-empty text delta, in arrival order.
 * @returns The round's assembled text and tool calls.
 */
async function consumeSseStream(
  stream: ReadableStream<Uint8Array>,
  onToken: (text: string) => void,
): Promise<StreamedRound> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const accumulators = new Map<number, ToolCallAccumulator>();
  let buffer = "";
  let text = "";

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
          text += delta;
          onToken(delta);
        }
        accumulateToolCallDeltas(
          extractStreamToolCallDeltas(parsed),
          accumulators,
        );
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls = [...accumulators.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, accumulator]) => ({
      arguments: parseToolArguments(accumulator.argumentsText),
      id: accumulator.id,
      name: accumulator.name,
    }))
    .filter((call) => call.name.length > 0);

  return { text, toolCalls };
}

/**
 * Run one round of the loop: a single streamed, tool-carrying `env.AI.run()` call.
 *
 * @param ai The narrowed Workers AI binding.
 * @param gatewayId AI Gateway id to route through.
 * @param model Workers AI model id.
 * @param messages The full message list for this round.
 * @param onToken Called once per streamed text delta.
 * @returns The round's assembled text and tool calls.
 */
async function runRound(
  ai: ChatAiBinding,
  gatewayId: string,
  model: string,
  messages: RoleScopedMessage[],
  onToken: (text: string) => void,
): Promise<StreamedRound> {
  const result = await ai.run(
    model,
    { messages, stream: true, tools: TOOL_DEFINITIONS },
    { gateway: { id: gatewayId } },
  );

  if (!(result instanceof ReadableStream)) {
    // Defensive: a test double or a binding that ignores `stream: true` is treated as an
    // already-complete round rather than crashing the turn.
    const text = extractObjectText(result);
    if (text.length > 0) onToken(text);
    return { text, toolCalls: extractObjectToolCalls(result) };
  }

  return consumeSseStream(result, onToken);
}

/**
 * Convert one normalized tool call back into the wire shape the follow-up request's
 * `role: "assistant"` message must echo.
 *
 * The echoed `arguments` are always re-serialized from the parsed value, never the raw text the
 * response carried. Workers AI validates this field on the way back in and rejects the entire
 * follow-up request with `400 Assistant tool call function.arguments must be valid JSON` if it
 * is not -- so echoing unparseable text verbatim would turn one recoverable tool error into a
 * hard failure of the whole turn (docs/DECISIONS.md #42). An unparseable call is echoed as `{}`
 * instead; its `role: "tool"` result already tells the model exactly what was wrong with it.
 *
 * @param call The tool call to echo.
 * @param index Its position within the round, used to synthesize an id when the response carried
 * none (the legacy Cloudflare-native shape).
 * @returns The wire-shaped tool call.
 */
function toWireToolCall(call: AiToolCall, index: number): WireToolCall {
  const parseable =
    typeof call.arguments === "object" && call.arguments !== null;
  return {
    function: {
      arguments: parseable ? JSON.stringify(call.arguments) : "{}",
      name: call.name,
    },
    id: call.id ?? `call_${index}`,
    type: "function",
  };
}

/**
 * Run one full turn of docs/09D-ARCHITECT-AICHAT.md's Chat Loop And Tool Execution: a bounded,
 * model-driven tool-calling loop against Workers AI.
 *
 * The loop, precisely:
 * 1. Build the system prompt from the diagram's current title/description and the live product
 *    catalog digest ({@link buildSystemPrompt}).
 * 2. Call `env.AI.run()` with `stream: true` and the full tool catalog, relaying every streamed
 *    text delta to `onToken` and assembling any streamed tool calls ({@link runRound}).
 * 3. If the round made no tool calls, the turn is over -- its streamed text is the final answer.
 *    Otherwise run each tool call's effect ({@link executeToolCall}), append the round's tool
 *    calls and their results to a turn-local message array (never the caller's persisted
 *    `messages` history) as an OpenAI-shaped `role: "assistant"`/`role: "tool"` exchange, and
 *    return to step 2 -- capped at {@link MAX_TOOL_ROUNDS} tool-calling rounds, after which one
 *    synthetic `system` message tells the model it has reached its action limit and exactly one
 *    further round is run to collect its final answer.
 * 4. Return the assembled answer, the total tool-call count, and whether the turn mutated the
 *    diagram -- the caller is responsible for appending the final `{ role: "user" }`/
 *    `{ role: "assistant" }` pair to its own persisted history and for logging
 *    `ai_chat_turn_completed`.
 *
 * @param input See {@link RunDiagramChatTurnInput}.
 * @returns See {@link RunDiagramChatTurnResult}.
 * @throws {Error} On any unexpected/uncaught failure anywhere in the loop -- a genuinely thrown
 * error from `applyMutation`/`renameDiagram` that is not a normal `{ rejected: true }` result, or
 * an AI Gateway/binding-level failure. This function never catches or swallows such an error; the
 * caller (`DiagramSession`) is responsible for catching it, sending a `chat_error` frame to the
 * originating connection only, and logging `ai_chat_turn_failed`.
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
  let assistantText = "";

  // Index 0 is always the system message; it is rewritten in place before every round so the
  // model's view of the canvas matches what its own previous round's tool calls just did.
  const turnMessages: RoleScopedMessage[] = [
    { content: buildSystemPrompt(title, description, graph), role: "system" },
    ...messages,
    { content: text, role: "user" },
  ];

  const toolContext: ToolExecutionContext = {
    applyMutation,
    onDocsLookup,
    onStatus,
    renameDiagram,
  };

  // `MAX_TOOL_ROUNDS + 1`: the extra trailing round is the one that turns ACTION_LIMIT_MESSAGE
  // into a final answer. Any tool calls it still makes are deliberately ignored.
  for (let round = 1; round <= MAX_TOOL_ROUNDS + 1; round += 1) {
    turnMessages[0] = {
      content: buildSystemPrompt(title, description, graph),
      role: "system",
    };
    const streamed = await runRound(
      env.AI,
      env.AI_GATEWAY_ID,
      env.AI_CHAT_MODEL,
      turnMessages,
      onToken,
    );
    assistantText += streamed.text;

    if (streamed.toolCalls.length === 0 || round > MAX_TOOL_ROUNDS) break;

    const calls = streamed.toolCalls.map((call, index) => ({
      call,
      wire: toWireToolCall(call, index),
    }));
    turnMessages.push({
      content: null,
      role: "assistant",
      tool_calls: calls.map(({ wire }) => wire),
    });

    for (const { call, wire } of calls) {
      toolCallCount += 1;
      const outcome = await executeToolCall(call, graph, toolContext);
      graph = outcome.nextGraph;
      if (outcome.mutatedNow) mutated = true;
      turnMessages.push({
        content: outcome.resultText,
        role: "tool",
        tool_call_id: wire.id,
      });
    }

    if (round === MAX_TOOL_ROUNDS) {
      turnMessages.push({ content: ACTION_LIMIT_MESSAGE, role: "system" });
    }
  }

  return { assistantText, mutated, toolCallCount };
}
