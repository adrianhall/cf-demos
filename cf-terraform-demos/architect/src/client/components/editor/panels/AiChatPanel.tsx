import { lazy, Suspense, useId, useState } from 'react';
import { AlertCircle, ExternalLink, RefreshCw, Send, StopCircle } from 'react-feather';
import type { ChatTranscriptEntry } from '../chat-transcript.ts';

/**
 * The Markdown renderer, in a chunk of its own.
 *
 * `react-markdown` plus `remark-gfm` is around 155 kB raw for a panel most sessions never open, so
 * it is loaded on demand for exactly the reason `../../../lib/auto-layout.ts` loads ELK on demand:
 * nothing a visitor may never use belongs in the bundle every visitor downloads.
 */
const MarkdownRenderer = lazy(async () => {
  const [{ default: Markdown }, { default: remarkGfm }] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm')
  ]);
  return {
    default: ({ text }: { text: string }) => <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
  };
});

/**
 * Props for {@link AssistantMarkdown}.
 */
interface AssistantMarkdownProps {
  /**
   * The assistant's Markdown text. Rendered mid-stream as well, so it is routinely incomplete: an
   * unterminated `**` or a half-written table degrades to plain text for that fragment and resolves
   * itself as the remaining tokens arrive.
   */
  text: string;
}

/**
 * Renders the assistant's answer as Markdown.
 *
 * The model writes Markdown whether or not it is asked to — headings, bold, bullet lists, fenced
 * code and GFM tables all appear in ordinary answers — so rendering the raw string showed the
 * syntax characters themselves, and with no `white-space: pre-wrap` even the line breaks collapsed
 * into one run-on paragraph. `remark-gfm` is what turns the model's very common table output into a
 * real `<table>`.
 *
 * **No `rehype-raw`, deliberately.** `react-markdown` ignores embedded HTML by default, and that
 * default is the property that stops model-authored text from being an injection vector here.
 * Adding `rehype-raw` would make a model that was talked into emitting a `<script>` tag able to put
 * one in this panel.
 *
 * @param props The text to render; see {@link AssistantMarkdownProps}.
 * @returns The rendered answer.
 */
function AssistantMarkdown({ text }: AssistantMarkdownProps) {
  return (
    <div className="ai-chat-panel__markdown">
      {/* The fallback is the same text unformatted rather than a spinner: the chunk resolves in a
          single same-origin request, and showing the answer immediately — briefly unstyled — beats
          withholding it behind a loading state. */}
      <Suspense fallback={<p className="ai-chat-panel__markdown-raw">{text}</p>}>
        <MarkdownRenderer text={text} />
      </Suspense>
    </div>
  );
}

/**
 * Props for {@link TranscriptEntry}.
 */
interface TranscriptEntryProps {
  /**
   * The entry to render.
   */
  entry: ChatTranscriptEntry;
}

/**
 * Renders one transcript entry.
 *
 * A `switch` rather than a lookup table: each branch's markup differs enough — the sources list, a
 * stopped note, an error's icon — that a shared shape would need as many conditionals inside it.
 *
 * @param props The entry; see {@link TranscriptEntryProps}.
 * @returns The entry's markup.
 */
function TranscriptEntry({ entry }: TranscriptEntryProps) {
  // Assigned in the switch and returned once, matching `../../../lib/describe-operation.ts` and
  // `src/worker/domain/graph-operations.ts`: definite-assignment analysis turns a transcript kind
  // nobody rendered into a build failure rather than a silently blank line.
  let rendered: React.ReactElement;

  switch (entry.kind) {
    case 'user':
      rendered = (
        <div className="ai-chat-panel__message ai-chat-panel__message--user">
          <p>{entry.text}</p>
        </div>
      );
      break;
    case 'assistant':
      rendered = (
        <div className="ai-chat-panel__message ai-chat-panel__message--assistant">
          <AssistantMarkdown text={entry.text} />
          {entry.stopped && (
            <p className="ai-chat-panel__stopped-note">
              Stopped watching this response — the assistant may still be working in the background.
            </p>
          )}
        </div>
      );
      break;
    case 'status':
      rendered = <p className="ai-chat-panel__status">{entry.text}</p>;
      break;
    case 'action':
      rendered = <p className="ai-chat-panel__action">{entry.text}</p>;
      break;
    case 'error':
      rendered = (
        <div className="ai-chat-panel__message ai-chat-panel__message--error">
          <AlertCircle size={14} aria-hidden="true" />
          <p>{entry.text}</p>
        </div>
      );
      break;
    case 'docs_result':
      rendered = (
        <div className="ai-chat-panel__message ai-chat-panel__message--docs">
          <p>Searched Cloudflare docs for “{entry.query}”</p>
          {entry.outcome.ok ? (
            entry.outcome.results.length > 0 ? (
              <ul className="ai-chat-panel__sources">
                {entry.outcome.results.map((result) => (
                  <li key={result.url}>
                    {/* Opened in a new tab for the reason the properties panel's documentation
                        links are: following a citation must not navigate away from an editor
                        holding unsaved work. */}
                    <a
                      href={result.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ai-chat-panel__source-link"
                    >
                      <ExternalLink
                        className="ai-chat-panel__source-icon"
                        size={14}
                        aria-hidden="true"
                      />
                      <span>{result.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ai-chat-panel__empty">No documentation results found.</p>
            )
          ) : (
            // The failure is shown rather than suppressed: a turn that answered without being able
            // to check its facts is something the reader should know about.
            <p className="ai-chat-panel__empty">{entry.outcome.message}</p>
          )}
        </div>
      );
      break;
  }

  return rendered;
}

/**
 * Props for {@link AiChatPanel}.
 */
export interface AiChatPanelProps {
  /**
   * Every entry accumulated on this connection so far, in arrival order.
   */
  transcript: ChatTranscriptEntry[];
  /**
   * Whether a turn is awaiting its own `chat_done` or `chat_error`. Disables Send and reveals Stop,
   * so the two controls cannot both be live at once.
   */
  inFlight: boolean;
  /**
   * Sends the composer's text as a new chat message.
   *
   * @param text The person's message, already trimmed.
   * @returns `false` when the socket was not open, in which case the draft is kept so nothing the
   *   visitor typed is lost to a dropped connection.
   */
  onSend: (text: string) => boolean;
  /**
   * Stops watching the in-flight turn. Client-side only; see {@link AiChatPanel}.
   *
   * @returns Nothing.
   */
  onStop: () => void;
  /**
   * Clears this tab's own transcript.
   *
   * @returns Nothing.
   */
  onNewConversation: () => void;
}

/**
 * The details panel's AI Assistant tab: a transcript and a composer.
 *
 * It renders what it is given and nothing else. Every frame is handled by `../DiagramCanvas.tsx`,
 * which already owns the one live socket, so this component never opens a connection of its own — a
 * second socket to the same diagram would double this tab's presence and give it two unordered
 * views of the same operation stream.
 *
 * The transcript is **one** `role="log"` with `aria-live="polite"` for the whole conversation
 * rather than one region per entry. A streamed answer mutates the text of a node already inside
 * that region, which a polite log coalesces into a single announcement; a region per token would
 * announce every fragment separately and make the panel unusable with a screen reader.
 *
 * **Stop is "stop watching", not "cancel".** The protocol has no cancellation frame — a turn is
 * already running inside the Durable Object, and the session's resilience design has it run to
 * completion even when its originator disconnects entirely. Pressing Stop therefore suppresses this
 * tab's rendering of the rest of the answer; any mutation the turn still makes continues to arrive
 * as an ordinary `operation_applied` broadcast and is still applied to the canvas. The wording on
 * the resulting bubble says exactly that rather than implying the model stopped.
 *
 * @param props Transcript, in-flight state and the three callbacks; see {@link AiChatPanelProps}.
 * @returns The assistant tab's content.
 */
export function AiChatPanel({
  transcript,
  inFlight,
  onSend,
  onStop,
  onNewConversation
}: AiChatPanelProps) {
  const [draft, setDraft] = useState('');
  const textareaId = useId();

  /**
   * Sends the draft, clearing it only once the send is known to have reached the socket.
   *
   * @param event The composer's submit event.
   * @returns Nothing.
   */
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const text = draft.trim();
    // The Send button is disabled in both of these cases, so neither is reachable by clicking it.
    // The guard is here because Enter in the textarea submits the form directly, which no disabled
    // button can prevent.
    if (text.length === 0 || inFlight) {
      return;
    }
    if (onSend(text)) {
      setDraft('');
    }
  };

  return (
    <div className="ai-chat-panel">
      <div className="ai-chat-panel__header">
        <button
          type="button"
          onClick={onNewConversation}
          className="ai-chat-panel__new-conversation"
          title="Start a new conversation"
        >
          <RefreshCw size={14} aria-hidden="true" />
          <span>New conversation</span>
        </button>
      </div>

      <div className="ai-chat-panel__transcript" role="log" aria-live="polite">
        {transcript.length === 0 && (
          <p className="ai-chat-panel__empty">
            Ask the assistant to add nodes, explain the diagram, or search Cloudflare&apos;s docs.
          </p>
        )}
        {transcript.map((entry) => (
          <TranscriptEntry key={entry.id} entry={entry} />
        ))}
      </div>

      <form onSubmit={handleSubmit} className="ai-chat-panel__composer">
        <label htmlFor={textareaId} className="visually-hidden">
          Message the AI assistant
        </label>
        <textarea
          id={textareaId}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="ai-chat-panel__textarea"
          rows={2}
          placeholder="Ask the assistant to add nodes, explain the diagram, or search docs…"
        />
        <div className="ai-chat-panel__composer-actions">
          {inFlight && (
            <button
              type="button"
              onClick={onStop}
              className="ai-chat-panel__stop"
              title="Stop watching this response"
            >
              <StopCircle size={16} aria-hidden="true" />
              <span>Stop</span>
            </button>
          )}
          {/* Icon-only, so it carries its own name rather than relying on the glyph. */}
          <button
            type="submit"
            disabled={inFlight || draft.trim().length === 0}
            className="ai-chat-panel__send"
            aria-label="Send message"
            title="Send"
          >
            <Send size={16} aria-hidden="true" />
          </button>
        </div>
      </form>
    </div>
  );
}
