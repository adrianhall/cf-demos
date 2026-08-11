import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as mockXyflow from "../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { RemoteCursorsOverlay } = await import("./RemoteCursorsOverlay");

describe("RemoteCursorsOverlay", () => {
  beforeEach(() => {
    mockXyflow.mockGetInternalNode.mockReset().mockReturnValue(undefined);
  });

  it("renders nothing when there are no cursors or node selections", () => {
    const { container } = render(
      <RemoteCursorsOverlay cursors={{}} remoteSelections={{}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("is aria-hidden -- a spatial convenience with no assistive-technology semantics", () => {
    render(
      <RemoteCursorsOverlay
        cursors={{
          "alice@example.com": { color: "#111111", x: 10, y: 20 },
        }}
        remoteSelections={{}}
      />,
    );
    expect(screen.getByTestId("rf-viewport-portal").firstChild).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("renders a labeled, positioned cursor for each entry", () => {
    render(
      <RemoteCursorsOverlay
        cursors={{
          "alice@example.com": { color: "#111111", x: 10, y: 20 },
        }}
        remoteSelections={{}}
      />,
    );

    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("does not render a selection highlight when getInternalNode returns undefined (a stale/unknown node id)", () => {
    mockXyflow.mockGetInternalNode.mockReturnValue(undefined);
    const { container } = render(
      <RemoteCursorsOverlay
        cursors={{}}
        remoteSelections={{
          "bob@example.com": { color: "#222222", edgeId: null, nodeId: "n1" },
        }}
      />,
    );
    expect(container.querySelector(".remote-selection-highlight")).toBeNull();
  });

  it("renders a positioned selection highlight sized from the node's internal geometry", () => {
    mockXyflow.mockGetInternalNode.mockReturnValue({
      internals: { positionAbsolute: { x: 30, y: 40 } },
      measured: { height: 60, width: 120 },
    });
    const { container } = render(
      <RemoteCursorsOverlay
        cursors={{}}
        remoteSelections={{
          "bob@example.com": { color: "#222222", edgeId: null, nodeId: "n1" },
        }}
      />,
    );

    const highlight = container.querySelector(
      ".remote-selection-highlight",
    ) as HTMLElement;
    expect(highlight).not.toBeNull();
    expect(highlight).toHaveStyle({
      left: "30px",
      top: "40px",
      width: "120px",
      height: "60px",
    });
  });

  it("falls back to a 0 width/height when the node's measured dimensions are not yet known", () => {
    mockXyflow.mockGetInternalNode.mockReturnValue({
      internals: { positionAbsolute: { x: 1, y: 2 } },
      measured: {},
    });
    const { container } = render(
      <RemoteCursorsOverlay
        cursors={{}}
        remoteSelections={{
          "bob@example.com": { color: "#222222", edgeId: null, nodeId: "n1" },
        }}
      />,
    );

    const highlight = container.querySelector(
      ".remote-selection-highlight",
    ) as HTMLElement;
    expect(highlight).toHaveStyle({ width: "0px", height: "0px" });
  });

  it("does not render a highlight for an edge-only selection (documented simplification)", () => {
    const { container } = render(
      <RemoteCursorsOverlay
        cursors={{}}
        remoteSelections={{
          "carol@example.com": {
            color: "#333333",
            edgeId: "e1",
            nodeId: null,
          },
        }}
      />,
    );
    expect(container.querySelector(".remote-selection-highlight")).toBeNull();
    expect(mockXyflow.mockGetInternalNode).not.toHaveBeenCalled();
  });
});
