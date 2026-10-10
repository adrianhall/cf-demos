/**
 * One part of a persisted `UIMessage`, as returned by `AIChatAgent`'s own built-in
 * `get-messages` endpoint (docs/06-AGENTIC-CHAT.md Phase 12, US-11) -- the same wire shape
 * `src/client/composables/useChatAgent.ts`'s own `PersistedMessagePart` already reads
 * client-side, duplicated here rather than imported across the Worker/client boundary (mirrors
 * that file's own documented convention, and this Worker's `chat-agent.ts`/`useChatAgent.ts`
 * split generally: neither side imports the other's types).
 *
 * A tool-call part's `type` is either `tool-<name>` (this demo's own three tools --
 * `writeMarkdown`, `getUrl`, `activate_skill`/`read_skill_resource` -- and any other tool
 * `streamText()`'s `tools` records by a statically known name, the `ai` SDK's own `ToolUIPart`
 * shape) or `dynamic-tool` (a tool discovered only at runtime with no statically known name,
 * carrying its own {@link toolName} field instead, the `ai` SDK's `DynamicToolUIPart` shape) --
 * this demo's own tools are all statically named, but {@link buildChatExportMarkdown} (in
 * `./chat-markdown.ts`) handles both shapes so a future tool of either kind still exports
 * legibly rather than being silently dropped.
 */
export interface ExportMessagePart {
  /** `"text"` for plain assistant/user text, `"tool-<name>"`/`"dynamic-tool"` for a tool-call
   * part, or any other AI SDK UI-message part type this export deliberately does not render
   * (a reasoning part, a step boundary) -- see `./chat-markdown.ts`'s own part-handling JSDoc. */
  readonly type: string;
  /** Present only on a `"text"` part. */
  readonly text?: string;
  /** Present only on a `"dynamic-tool"` part -- the tool's name, since `type` itself carries no
   * name for that shape (unlike a static `"tool-<name>"` part). */
  readonly toolName?: string;
  /** Present only on a tool-call part -- the specific invocation this part reports on. */
  readonly toolCallId?: string;
  /** Present only on a tool-call part -- the AI SDK's own tool-part lifecycle state (for
   * example `"output-available"`, `"output-error"`). */
  readonly state?: string;
  /** Present only on a tool-call part -- the model's own call arguments. */
  readonly input?: unknown;
  /** Present only on a tool-call part whose state is `"output-available"` -- the tool's own
   * result value. */
  readonly output?: unknown;
  /** Present only on a tool-call part whose state is `"output-error"`. */
  readonly errorText?: string;
}

/** One persisted `UIMessage`, as returned by the chat's `get-messages` endpoint -- the input
 * `./chat-markdown.ts`'s `buildChatExportMarkdown()` renders one Markdown section per message
 * for. */
export interface ExportMessage {
  /** The persisted message's own id. */
  readonly id: string;
  /** `"user"` or `"assistant"` -- anything else (there is none in this demo's own transcripts)
   * renders under a generic "You" label, mirroring `useChatAgent.ts`'s own `toChatTurn()`
   * fallback. */
  readonly role: string;
  /** This message's ordered content parts. */
  readonly parts: readonly ExportMessagePart[];
}
