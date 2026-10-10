import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseIdentity } = vi.hoisted(() => ({ mockUseIdentity: vi.fn() }));
vi.mock("../../hooks/useIdentity", () => ({ useIdentity: mockUseIdentity }));

const { useDiagramStore } = await import("../../stores/diagramStore");
const { LiveUpdateToast } = await import("./LiveUpdateToast");

describe("LiveUpdateToast", () => {
  beforeEach(() => {
    useDiagramStore.setState({ liveUpdateNotice: null });
    mockUseIdentity.mockReturnValue({
      email: "alice@example.com",
      error: null,
      isAdmin: false,
      loading: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when there is no live update notice", () => {
    render(<LiveUpdateToast />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it('renders "Updated by your agent" for an agent-originated edit', () => {
    useDiagramStore.setState({
      liveUpdateNotice: { actorEmail: "alice@example.com", origin: "agent" },
    });
    render(<LiveUpdateToast />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Updated by your agent",
    );
  });

  it('renders "Updated by AI Assistant" for an ai-chat-originated edit', () => {
    useDiagramStore.setState({
      liveUpdateNotice: {
        actorEmail: "alice@example.com",
        origin: "ai-chat",
      },
    });
    render(<LiveUpdateToast />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Updated by AI Assistant",
    );
  });

  it('renders "Updated by <email>" for a different human collaborator', () => {
    useDiagramStore.setState({
      liveUpdateNotice: { actorEmail: "bob@example.com", origin: "human" },
    });
    render(<LiveUpdateToast />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Updated by bob@example.com",
    );
  });

  it('renders "Updated by you" for this tab\'s own identity editing from another tab', () => {
    useDiagramStore.setState({
      liveUpdateNotice: { actorEmail: "alice@example.com", origin: "human" },
    });
    render(<LiveUpdateToast />);
    expect(screen.getByRole("status")).toHaveTextContent("Updated by you");
  });

  it("falls back to the raw email while the viewer identity has not loaded yet", () => {
    mockUseIdentity.mockReturnValue({
      email: null,
      error: null,
      isAdmin: false,
      loading: true,
    });
    useDiagramStore.setState({
      liveUpdateNotice: { actorEmail: "alice@example.com", origin: "human" },
    });
    render(<LiveUpdateToast />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Updated by alice@example.com",
    );
  });

  it("dismisses on manual click", () => {
    useDiagramStore.setState({
      liveUpdateNotice: { actorEmail: "bob@example.com", origin: "human" },
    });
    render(<LiveUpdateToast />);

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );

    expect(useDiagramStore.getState().liveUpdateNotice).toBeNull();
  });

  it("auto-dismisses after its timer elapses", () => {
    vi.useFakeTimers();
    useDiagramStore.setState({
      liveUpdateNotice: { actorEmail: "bob@example.com", origin: "human" },
    });
    render(<LiveUpdateToast />);

    vi.advanceTimersByTime(6_000);

    expect(useDiagramStore.getState().liveUpdateNotice).toBeNull();
  });
});
