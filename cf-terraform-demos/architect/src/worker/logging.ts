/**
 * @file The one vocabulary every structured log event in this Worker uses to say which surface
 *   performed a change. Two transports now reach the same use cases — the browser's HTTP API and
 *   the remote MCP endpoint — and an operator reading Workers Logs needs to tell an agent's edit
 *   apart from a person's without a second event name or a second table. **It also holds the one
 *   logging call a Durable Object can make.** Everywhere else in this Worker, logging goes through
 *   `@adrianhall/cloudflare-toolkit`'s `cloudflareLogger()`, which resolves a request-scoped
 *   `Logger` onto a Hono `Context` at middleware time. A session has no `Context`: a
 *   `webSocketMessage()` invocation is not a request, so there is nothing to hang a request-scoped
 *   logger off, and threading one in across the RPC or socket boundary is not available either — a
 *   `Logger` is not structured-cloneable, which is the same constraint that already forced this
 *   project's graph operations to be values rather than closures (see
 *   `./domain/graph-operations.ts`). {@link logSessionEvent} is therefore a deliberate, narrow
 *   exception rather than a second logging style: one typed union, one `JSON.stringify`, and the
 *   privacy rule enforced in a single testable place.
 */

/**
 * Which transport a logged change arrived through.
 *
 * Written as one shared type rather than a string literal at each call site so the two spellings
 * cannot drift: a log pipeline filtering on `via` breaks silently if one route starts emitting
 * `"API"` or `"mcp-tool"`, and a silent break in observability is only discovered when somebody
 * needs the data.
 *
 * - `api` — an HTTP request to `/api/*`, which in practice means the browser client.
 * - `mcp` — a tool call against `POST /mcp`, which in practice means an external agent harness.
 *
 * It deliberately does not name the client. Two agent harnesses are the same thing to an operator
 * asking "did a person or an agent change this diagram", and recording a client-supplied name would
 * put an unverified value into an operational log.
 *
 * The administrative events (`admin_diagram_opened`, `admin_diagram_deleted`) deliberately carry no
 * `via` field. They are named for the surface that emits them and no MCP tool can reach them, so a
 * constant `'api'` there would be a value that could never vary — which reads as a question worth
 * asking rather than one already answered.
 */
export type LogVia = 'api' | 'mcp';

/**
 * One AI chat turn that completed, however much or little it did.
 *
 * Every field is a count, a flag, a duration or an identifier the operator already knows. **None of
 * them is content**, and that is the type's main job: there is no field here a prompt, an answer, a
 * documentation snippet or any part of a diagram could be put in, so the privacy rule is enforced
 * by the compiler rather than by remembering it at a call site.
 *
 * The honest framing, which belongs in the README too: this says the _Worker's_ logs carry no
 * content. AI Gateway may still log payloads, which is the gateway's behaviour and not something
 * the application can promise on a user's behalf.
 */
export interface AiChatTurnCompletedEvent {
  /**
   * Discriminator and log event name.
   */
  event: 'ai_chat_turn_completed';
  /**
   * Diagram the turn ran against.
   */
  diagramId: string;
  /**
   * Workers AI model id the turn used, so a cost figure can be attributed after a model change.
   */
  model: string;
  /**
   * How many tool calls the turn executed in total, across every round.
   */
  toolCallCount: number;
  /**
   * Whether the turn actually changed the diagram. `false` for a purely explanatory turn, and also
   * for one whose every mutation attempt was refused — which is the pair an operator wants to see
   * diverge from `toolCallCount`.
   */
  mutated: boolean;
  /**
   * Wall-clock duration of the whole turn, in milliseconds.
   */
  latencyMs: number;
}

/**
 * One AI chat turn that failed before it could answer.
 */
export interface AiChatTurnFailedEvent {
  /**
   * Discriminator and log event name.
   */
  event: 'ai_chat_turn_failed';
  /**
   * Diagram the turn ran against.
   */
  diagramId: string;
  /**
   * The thrown `Error.message`, and deliberately nothing wider.
   *
   * Kept to the message rather than widened to a response body precisely because this is the one
   * field in the whole vocabulary that carries free text: a body from a failed inference call can
   * contain the prompt that produced it, which would put content into a log that promises to have
   * none.
   */
  reason: string;
}

/**
 * One documentation lookup the assistant performed.
 *
 * It records that a lookup happened, how long it took and how much it found — never the query and
 * never the returned text. What a person asked the documentation is as much their content as what
 * they asked the assistant.
 */
export interface AiDocsLookupPerformedEvent {
  /**
   * Discriminator and log event name.
   */
  event: 'ai_docs_lookup_performed';
  /**
   * How many pages the lookup returned. Zero both for a search that matched nothing and for one
   * that failed; the two are distinguished by `latencyMs` and by the turn's own outcome rather than
   * by naming the failure here.
   */
  resultCount: number;
  /**
   * Wall-clock duration of the lookup, in milliseconds.
   */
  latencyMs: number;
}

/**
 * Every structured event a diagram session or a chat turn may emit.
 *
 * A discriminated union so the three shapes' field names are checked by the compiler — the same
 * reason {@link LogVia} exists. A log pipeline filtering on `event` and reading `toolCallCount`
 * breaks silently if one call site spells a field differently, and a silent break in observability
 * is only discovered when somebody needs the data.
 */
export type SessionLogEvent =
  | AiChatTurnCompletedEvent
  | AiChatTurnFailedEvent
  | AiDocsLookupPerformedEvent;

/**
 * Writes one structured session event to the Workers Logs stream.
 *
 * Serialized into a **single** argument rather than passed as an object, because Workers Logs
 * parses a lone JSON string argument as structured data — which is what makes `event` and
 * `toolCallCount` filterable fields rather than part of a message blob.
 *
 * A failure is written with `console.error` so it is separable by severity without a second field
 * saying so; everything else is `console.log`.
 *
 * @param event The event to write; see {@link SessionLogEvent}.
 * @returns Nothing.
 * @throws Nothing. A logging call must never be the thing that fails a chat turn, and `console`
 *   does not throw in this runtime; there is deliberately no `try` here to suggest otherwise.
 */
export function logSessionEvent(event: SessionLogEvent): void {
  const line = JSON.stringify(event);
  if (event.event === 'ai_chat_turn_failed') {
    console.error(line);
    return;
  }
  console.log(line);
}
