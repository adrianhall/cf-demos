import { lazy, Suspense, useId, useState } from "react";
import {
  AlertCircle,
  ExternalLink,
  RefreshCw,
  Send,
  StopCircle,
} from "react-feather";
import type { ChatTranscriptEntry } from "../../../hooks/useDiagramLiveSync";

/**
 * The Markdown renderer, split into its own chunk.
 *
 * `react-markdown` + `remark-gfm` add roughly 155kB raw / 46kB gzip -- a quarter again on top of
 * the client's main bundle -- for a panel most sessions never open. Loading it on demand keeps it
 * out of the eager bundle, following the same reasoning as `../../../lib/auto-layout.ts`'s
 * dynamic `elkjs` import. See docs/DECISIONS.md #43.
 */
const MarkdownRenderer = lazy(async () => {
  const [{ default: Markdown }, { default: remarkGfm }] = await Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
  ]);
  return {
    default: ({ text }: { text: string }) => (
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    ),
  };
});

/**
 * Render the assistant's answer as Markdown.
 *
 * The model writes Markdown unprompted -- headings, bold, bullet lists, fenced code and GFM
 * tables all appear in ordinary answers -- so rendering the raw string showed the syntax
 * characters literally, and with no `white-space: pre-wrap` even the line breaks collapsed into
 * one run-on paragraph (docs/DECISIONS.md #43).
 *
 * `remark-gfm` is what turns the model's very common table output into a real `<table>`. No
 * `rehype-raw`: `react-markdown` ignores embedded HTML by default, and that default is the
 * property that keeps model-authored text from becoming an HTML injection vector here.
 *
 * @param text The assistant's Markdown text. Rendered mid-stream too, so it is routinely
 * incomplete -- an unterminated `**` or half-written table degrades to plain text for that
 * fragment and resolves itself as the rest of the tokens arrive.
 */
function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="ai-chat-panel__markdown">
      {/* The fallback is the same text unformatted rather than a spinner: the chunk resolves in
          a single same-origin request, and showing the answer immediately -- briefly unstyled --
          beats withholding it behind a loading state. */}
      <Suspense
        fallback={<p className="ai-chat-panel__markdown-raw">{text}</p>}
      >
        <MarkdownRenderer text={text} />
      </Suspense>
    </div>
  );
}

/**
 * Render one transcript entry. A plain `switch` rather than a lookup table -- each branch's JSX
 * differs enough (a `"docs_result"` entry's `Sources` list, an `"assistant"` entry's `stopped`
 * note) that a shared shape would need almost as many conditionals inside it anyway.
 *
 * @param entry The entry to render.
 */
function TranscriptEntry({ entry }: { entry: ChatTranscriptEntry }) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="ai-chat-panel__message ai-chat-panel__message--user">
          <p>{entry.text}</p>
        </div>
      );

    case "assistant":
      return (
        <div className="ai-chat-panel__message ai-chat-panel__message--assistant">
          <AssistantMarkdown text={entry.text} />
          {entry.stopped && (
            <p className="ai-chat-panel__stopped-note">
              Stopped watching this response -- the assistant may still be
              working in the background.
            </p>
          )}
        </div>
      );

    case "status":
      return <p className="ai-chat-panel__status">{entry.text}</p>;

    case "action":
      return <p className="ai-chat-panel__action">{entry.text}</p>;

    case "error":
      return (
        <div className="ai-chat-panel__message ai-chat-panel__message--error">
          <AlertCircle size={14} aria-hidden="true" />
          <p>{entry.text}</p>
        </div>
      );

    case "docs_result":
      return (
        <div className="ai-chat-panel__message ai-chat-panel__message--docs">
          <p>Searched Cloudflare docs for “{entry.query}”</p>
          {Array.isArray(entry.result) ? (
            entry.result.length > 0 ? (
              <ul className="ai-chat-panel__sources">
                {entry.result.map((doc) => (
                  <li key={doc.url}>
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ai-chat-panel__source-link"
                    >
                      <ExternalLink
                        className="ai-chat-panel__source-icon"
                        size={14}
                        aria-hidden="true"
                      />
                      <span>{doc.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ai-chat-panel__empty">
                No documentation results found.
              </p>
            )
          ) : (
            <p className="ai-chat-panel__empty">{entry.result.message}</p>
          )}
        </div>
      );
  }
}

/**
 * The AI Assistant tab's own content, rendered by `./DetailsPanel.tsx` for
 * `detailsPanelTab === "ai-chat"` (docs/09D-ARCHITECT-AICHAT.md's In-Editor Chat).
 *
 * Renders a scrollable transcript (`role="log"`, `aria-live="polite"`) of every entry
 * `../../../hooks/useDiagramLiveSync.ts` has accumulated for this connection, and a composer: a
 * labeled `<textarea>`, a `Send` submit button (disabled while a turn is in flight or the
 * textarea is empty), and a `Stop` button shown only while a turn is streaming. A "New
 * conversation" header control clears only this tab's own local transcript -- see
 * `../../../hooks/useDiagramLiveSync.ts`'s own JSDoc for the documented, accepted gap between
 * this and `DiagramSession`'s own per-connection history.
 *
 * Every prop here is a plain value/callback threaded down from `./DetailsPanel.tsx` (in turn
 * threaded from `../DiagramCanvas.tsx`'s own single `useDiagramLiveSync()` call) -- this
 * component never calls that hook itself, so it never opens a second WebSocket connection.
 */
export function AiChatPanel({
  transcript,
  inFlight,
  onSend,
  onStop,
  onNewConversation,
}: {
  /** Transcript entries to render, in arrival order. */
  transcript: ChatTranscriptEntry[];
  /** Whether a turn is currently in flight -- disables Send and shows Stop. */
  inFlight: boolean;
  /** Send the composer's current text as a new chat message. */
  onSend: (text: string) => string | false;
  /** Stop watching the in-flight turn's remaining response (client-side only). */
  onStop: () => void;
  /** Clear this tab's own local transcript. */
  onNewConversation: () => void;
}) {
  const [draft, setDraft] = useState("");
  const textareaId = useId();

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0 || inFlight) return;
    if (onSend(text) !== false) {
      setDraft("");
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
            Ask the assistant to add nodes, explain the diagram, or search
            Cloudflare's docs.
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
