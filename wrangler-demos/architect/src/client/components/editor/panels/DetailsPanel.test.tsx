import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DETAILS_PANEL_EXPANDED_STORAGE_KEY } from "../../../lib/details-panel-preferences";
import { useDiagramStore } from "../../../stores/diagramStore";
import { DetailsPanel } from "./DetailsPanel";

/** Default props for a `DetailsPanel` render: an empty, idle chat panel. */
function chatProps() {
  return {
    chatInFlight: false,
    chatTranscript: [],
    clearChatTranscript: vi.fn(),
    sendChatMessage: vi.fn(() => false as const),
    stopChatTurn: vi.fn(),
  };
}

describe("DetailsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    useDiagramStore.setState({
      nodes: [],
      edges: [],
      selectedNodeId: null,
      selectedEdgeId: null,
      detailsPanelTab: "properties",
      detailsPanelExpanded: false,
      propertiesOpen: true,
    });
  });

  it("shows the Properties tab's content by default", () => {
    render(<DetailsPanel {...chatProps()} />);
    expect(
      screen.getByText("Select a node or edge to view its properties."),
    ).toBeInTheDocument();
  });

  it("implements the ARIA tabs pattern: tablist, two tabs, and a labeled tabpanel", () => {
    render(<DetailsPanel {...chatProps()} />);

    const tablist = screen.getByRole("tablist", { name: "Details panel" });
    expect(tablist).toBeInTheDocument();

    const propertiesTab = screen.getByRole("tab", { name: "Properties" });
    const chatTab = screen.getByRole("tab", { name: "AI Assistant" });
    expect(propertiesTab).toHaveAttribute("aria-selected", "true");
    expect(chatTab).toHaveAttribute("aria-selected", "false");

    const tabpanel = screen.getByRole("tabpanel");
    expect(tabpanel).toHaveAttribute(
      "aria-labelledby",
      propertiesTab.getAttribute("id"),
    );
    expect(propertiesTab).toHaveAttribute(
      "aria-controls",
      tabpanel.getAttribute("id"),
    );
  });

  it("switches to the AI Assistant tab on click, updating the store and the tabpanel label", () => {
    render(<DetailsPanel {...chatProps()} />);

    fireEvent.click(screen.getByRole("tab", { name: "AI Assistant" }));

    expect(useDiagramStore.getState().detailsPanelTab).toBe("ai-chat");
    const chatTab = screen.getByRole("tab", { name: "AI Assistant" });
    expect(chatTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      chatTab.getAttribute("id"),
    );
    // AiChatPanel's own composer, not PropertiesPanel's empty-state text, is now shown.
    expect(
      screen.getByLabelText("Message the AI assistant"),
    ).toBeInTheDocument();
  });

  it("switches back to the Properties tab on click when AI Assistant is active", () => {
    useDiagramStore.setState({ detailsPanelTab: "ai-chat" });
    render(<DetailsPanel {...chatProps()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Properties" }));

    expect(useDiagramStore.getState().detailsPanelTab).toBe("properties");
  });

  it("returns to the Properties tab when a node is selected, even while AI Assistant is active", () => {
    useDiagramStore.setState({ detailsPanelTab: "ai-chat" });
    render(<DetailsPanel {...chatProps()} />);
    expect(screen.getByRole("tab", { name: "AI Assistant" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    act(() => useDiagramStore.getState().setSelectedNode("n1"));

    expect(screen.getByRole("tab", { name: "Properties" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("has an accessible name for the icon-only expand/collapse control", () => {
    render(<DetailsPanel {...chatProps()} />);
    expect(
      screen.getByRole("button", { name: "Expand panel" }),
    ).toBeInTheDocument();
  });

  it("toggles the expanded width class and persists the preference to localStorage", () => {
    render(<DetailsPanel {...chatProps()} />);

    const toggle = screen.getByRole("button", { name: "Expand panel" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);

    expect(useDiagramStore.getState().detailsPanelExpanded).toBe(true);
    expect(localStorage.getItem(DETAILS_PANEL_EXPANDED_STORAGE_KEY)).toBe(
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Collapse panel" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("a full keyboard pass reaches every tab and the expand toggle", () => {
    render(<DetailsPanel {...chatProps()} />);

    const propertiesTab = screen.getByRole("tab", { name: "Properties" });
    const chatTab = screen.getByRole("tab", { name: "AI Assistant" });
    const expandToggle = screen.getByRole("button", { name: "Expand panel" });

    // Every control is a real <button>, so Tab/Enter/Space work natively -- exercised here via
    // direct focus + click, matching this codebase's existing keyboard-pass test convention.
    propertiesTab.focus();
    expect(document.activeElement).toBe(propertiesTab);
    chatTab.focus();
    expect(document.activeElement).toBe(chatTab);
    fireEvent.click(chatTab);
    expect(useDiagramStore.getState().detailsPanelTab).toBe("ai-chat");

    expandToggle.focus();
    expect(document.activeElement).toBe(expandToggle);
    fireEvent.click(expandToggle);
    expect(useDiagramStore.getState().detailsPanelExpanded).toBe(true);
  });
});
