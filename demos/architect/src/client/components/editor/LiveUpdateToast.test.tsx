import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiagramStore } from "../../stores/diagramStore";
import { LiveUpdateToast } from "./LiveUpdateToast";

describe("LiveUpdateToast", () => {
  beforeEach(() => {
    useDiagramStore.setState({ liveUpdateNotice: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when there is no live update notice", () => {
    render(<LiveUpdateToast />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the notice once liveUpdateNotice is set", () => {
    useDiagramStore.setState({ liveUpdateNotice: true });
    render(<LiveUpdateToast />);
    expect(screen.getByRole("status")).toHaveTextContent("Updated by an agent");
  });

  it("dismisses on manual click", () => {
    useDiagramStore.setState({ liveUpdateNotice: true });
    render(<LiveUpdateToast />);

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );

    expect(useDiagramStore.getState().liveUpdateNotice).toBe(false);
  });

  it("auto-dismisses after its timer elapses", () => {
    vi.useFakeTimers();
    useDiagramStore.setState({ liveUpdateNotice: true });
    render(<LiveUpdateToast />);

    vi.advanceTimersByTime(6_000);

    expect(useDiagramStore.getState().liveUpdateNotice).toBe(false);
  });
});
