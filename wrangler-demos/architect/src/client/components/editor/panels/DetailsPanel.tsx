import { useId } from "react";
import { Maximize2, Minimize2 } from "react-feather";
import type { ChatTranscriptEntry } from "../../../hooks/useDiagramLiveSync";
import { useDiagramStore } from "../../../stores/diagramStore";
import { AiChatPanel } from "./AiChatPanel";
import { PropertiesPanel } from "./PropertiesPanel";

/**
 * Thin wrapping component that owns the editor's right-hand sidebar slot
 * (docs/09D-ARCHITECT-AICHAT.md's In-Editor Chat: "Details panel: shared, expandable slot"),
 * replacing `../DiagramCanvas.tsx`'s previous direct render of `./PropertiesPanel.tsx`. Renders a
 * two-tab switch between **Properties** (`./PropertiesPanel.tsx`, entirely unchanged -- rendered
 * as this tab's content, not modified in any way by this wrapper) and **AI Assistant**
 * (`./AiChatPanel.tsx`), plus a header expand/collapse toggle for the whole panel's width.
 *
 * Implements the full WAI-ARIA Tabs pattern: a `role="tablist"` wrapping two `role="tab"`
 * buttons with `aria-selected`/`aria-controls`/`id`, and a single `role="tabpanel"`
 * (`aria-labelledby` pointing back at whichever tab is active) wrapping whichever panel is
 * currently shown -- `../../blueprints/BlueprintGallery.tsx`'s own category-filter `role="tablist"`
 * is only half this pattern (no `tabpanel` counterpart), so that precedent is extended here
 * rather than copied verbatim. Both tabs are real `<button>`s, so Tab/Enter/Space all work for
 * free with no extra keyboard handling needed to clear this repository's WCAG 2.2 AA bar.
 *
 * The chat props below are threaded through from `../DiagramCanvas.tsx`'s own single
 * `useDiagramLiveSync()` call, exactly like that component already threads `participants`/
 * `cursors`/`remoteSelections` down to `../toolbar/Toolbar.tsx`/`../RemoteCursorsOverlay.tsx` --
 * `./AiChatPanel.tsx` deliberately does not call the live-sync hook a second time, which would
 * open a second WebSocket connection to the same diagram.
 */
export function DetailsPanel({
  chatTranscript,
  chatInFlight,
  sendChatMessage,
  stopChatTurn,
  clearChatTranscript,
}: {
  /** The AI chat transcript accumulated on this connection so far
   * (`../../../hooks/useDiagramLiveSync.ts`'s `chatTranscript`). */
  chatTranscript: ChatTranscriptEntry[];
  /** Whether a chat turn is currently awaiting its own `chat_done`/`chat_error`. */
  chatInFlight: boolean;
  /** Send one chat message over the diagram's live socket. */
  sendChatMessage: (text: string) => string | false;
  /** Stop rendering further tokens for the in-flight turn (client-side-only; see
   * `../../../hooks/useDiagramLiveSync.ts`'s own JSDoc). */
  stopChatTurn: () => void;
  /** Clear this tab's own local chat transcript ("New conversation"). */
  clearChatTranscript: () => void;
}) {
  const detailsPanelTab = useDiagramStore((state) => state.detailsPanelTab);
  const setDetailsPanelTab = useDiagramStore(
    (state) => state.setDetailsPanelTab,
  );
  const detailsPanelExpanded = useDiagramStore(
    (state) => state.detailsPanelExpanded,
  );
  const toggleDetailsPanelExpanded = useDiagramStore(
    (state) => state.toggleDetailsPanelExpanded,
  );

  const propertiesTabId = useId();
  const chatTabId = useId();
  const tabpanelId = useId();

  const activeTabId =
    detailsPanelTab === "properties" ? propertiesTabId : chatTabId;

  return (
    <div
      className={`details-panel${detailsPanelExpanded ? " details-panel--expanded" : ""}`}
    >
      <div className="details-panel__header">
        <div
          className="details-panel__tablist"
          role="tablist"
          aria-label="Details panel"
        >
          <button
            type="button"
            id={propertiesTabId}
            role="tab"
            aria-selected={detailsPanelTab === "properties"}
            aria-controls={tabpanelId}
            className={`details-panel__tab${
              detailsPanelTab === "properties"
                ? " details-panel__tab--active"
                : ""
            }`}
            onClick={() => setDetailsPanelTab("properties")}
          >
            Properties
          </button>
          <button
            type="button"
            id={chatTabId}
            role="tab"
            aria-selected={detailsPanelTab === "ai-chat"}
            aria-controls={tabpanelId}
            className={`details-panel__tab${
              detailsPanelTab === "ai-chat" ? " details-panel__tab--active" : ""
            }`}
            onClick={() => setDetailsPanelTab("ai-chat")}
          >
            AI Assistant
          </button>
        </div>
        <button
          type="button"
          onClick={toggleDetailsPanelExpanded}
          className="details-panel__expand-toggle"
          aria-pressed={detailsPanelExpanded}
          title={detailsPanelExpanded ? "Collapse panel" : "Expand panel"}
          aria-label={detailsPanelExpanded ? "Collapse panel" : "Expand panel"}
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
        aria-labelledby={activeTabId}
        className="details-panel__tabpanel"
      >
        {detailsPanelTab === "properties" ? (
          <PropertiesPanel />
        ) : (
          <AiChatPanel
            transcript={chatTranscript}
            inFlight={chatInFlight}
            onSend={sendChatMessage}
            onStop={stopChatTurn}
            onNewConversation={clearChatTranscript}
          />
        )}
      </div>
    </div>
  );
}
