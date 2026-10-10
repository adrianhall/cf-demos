import { useId } from 'react';
import { Maximize2, Minimize2 } from 'react-feather';
import { useDiagramStore } from '../../../stores/diagramStore.ts';
import type { ChatTranscriptEntry } from '../chat-transcript.ts';
import { AiChatPanel } from './AiChatPanel.tsx';
import { PropertiesPanel } from './PropertiesPanel.tsx';

/**
 * Props for {@link DetailsPanel}.
 *
 * Every one of them belongs to the assistant tab and is threaded straight through, exactly as
 * `../DiagramCanvas.tsx` already threads presence down to the toolbar and the cursor overlay. The
 * canvas owns the single live socket, so the panel is handed the conversation rather than opening a
 * connection to fetch it.
 */
export interface DetailsPanelProps {
  /**
   * The assistant transcript accumulated on this connection so far.
   */
  chatTranscript: ChatTranscriptEntry[];
  /**
   * Whether a chat turn is awaiting its own `chat_done` or `chat_error`.
   */
  chatInFlight: boolean;
  /**
   * Sends one chat message over the diagram's live socket.
   *
   * @param text The person's message.
   * @returns Whether the frame reached the socket.
   */
  onSendChatMessage: (text: string) => boolean;
  /**
   * Stops rendering the in-flight turn's remaining answer; see {@link AiChatPanel}.
   *
   * @returns Nothing.
   */
  onStopChatTurn: () => void;
  /**
   * Clears the local transcript.
   *
   * @returns Nothing.
   */
  onNewConversation: () => void;
}

/**
 * The editor's right-hand sidebar slot.
 *
 * It owns the slot's width, border and — below the responsive breakpoint — its position as an
 * overlay drawer, leaving {@link PropertiesPanel} and {@link AiChatPanel} to be nothing but the
 * content that fills it. Separating the two is what lets the panel be widened without the
 * properties form knowing it has been, and it is why the assistant tab could arrive without
 * touching that form at all.
 *
 * The two tabs implement the full ARIA tabs pattern: a `role="tablist"` of two real `<button>`s
 * carrying `aria-selected` and `aria-controls`, and one `role="tabpanel"` whose `aria-labelledby`
 * tracks whichever tab is active. They are buttons rather than anything more elaborate, so Tab,
 * Enter and Space already work with no key handling of this component's own.
 *
 * Which tab is showing is store state rather than local state, because the toolbar's assistant
 * control sets it from outside this component and selecting a node resets it. It is deliberately
 * **not** persisted; see `diagramStore.ts`'s `detailsPanelTab` and
 * `../../../lib/details-panel-preferences.ts`, which persists the width and only the width.
 *
 * The width control is a toggle button rather than a drag handle: a drag has no keyboard
 * equivalent, and two widths are the whole of what the layout actually offers.
 *
 * @param props The assistant tab's transcript, state and callbacks; see {@link DetailsPanelProps}.
 * @returns The details panel.
 */
export function DetailsPanel({
  chatTranscript,
  chatInFlight,
  onSendChatMessage,
  onStopChatTurn,
  onNewConversation
}: DetailsPanelProps) {
  const detailsPanelExpanded = useDiagramStore((state) => state.detailsPanelExpanded);
  const toggleDetailsPanelExpanded = useDiagramStore((state) => state.toggleDetailsPanelExpanded);
  const detailsPanelTab = useDiagramStore((state) => state.detailsPanelTab);
  const setDetailsPanelTab = useDiagramStore((state) => state.setDetailsPanelTab);

  // Generated rather than written as literals, so two panels on one page — which the responsive
  // drawer makes possible during a transition — cannot produce duplicate ids and point a
  // tabpanel's `aria-labelledby` at the wrong tab.
  const propertiesTabId = useId();
  const chatTabId = useId();
  const tabpanelId = useId();

  const propertiesActive = detailsPanelTab === 'properties';
  const label = detailsPanelExpanded ? 'Collapse panel' : 'Expand panel';

  return (
    <div className={`details-panel${detailsPanelExpanded ? ' details-panel--expanded' : ''}`}>
      <div className="details-panel__header">
        <div className="details-panel__tablist" role="tablist" aria-label="Details panel">
          <button
            type="button"
            id={propertiesTabId}
            role="tab"
            aria-selected={propertiesActive}
            aria-controls={tabpanelId}
            className={`details-panel__tab${propertiesActive ? ' details-panel__tab--active' : ''}`}
            onClick={() => setDetailsPanelTab('properties')}
          >
            Properties
          </button>
          <button
            type="button"
            id={chatTabId}
            role="tab"
            aria-selected={!propertiesActive}
            aria-controls={tabpanelId}
            className={`details-panel__tab${!propertiesActive ? ' details-panel__tab--active' : ''}`}
            onClick={() => setDetailsPanelTab('ai-chat')}
          >
            AI Assistant
          </button>
        </div>
        <button
          type="button"
          onClick={toggleDetailsPanelExpanded}
          className="details-panel__expand-toggle"
          aria-pressed={detailsPanelExpanded}
          title={label}
          aria-label={label}
        >
          {detailsPanelExpanded ? (
            <Minimize2 size={16} aria-hidden="true" />
          ) : (
            <Maximize2 size={16} aria-hidden="true" />
          )}
        </button>
      </div>
      <div
        id={tabpanelId}
        role="tabpanel"
        aria-labelledby={propertiesActive ? propertiesTabId : chatTabId}
        className="details-panel__tabpanel"
      >
        {propertiesActive ? (
          <PropertiesPanel />
        ) : (
          <AiChatPanel
            transcript={chatTranscript}
            inFlight={chatInFlight}
            onSend={onSendChatMessage}
            onStop={onStopChatTurn}
            onNewConversation={onNewConversation}
          />
        )}
      </div>
    </div>
  );
}
