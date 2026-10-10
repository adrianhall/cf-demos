import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mockXyflow from "../../../test/mock-xyflow";

vi.mock("@xyflow/react", () => mockXyflow);

const { mockToPng, mockToSvg } = vi.hoisted(() => ({
  mockToPng: vi.fn(),
  mockToSvg: vi.fn(),
}));
vi.mock("html-to-image", () => ({ toPng: mockToPng, toSvg: mockToSvg }));

const { mockStrToU8, mockZipSync } = vi.hoisted(() => ({
  mockStrToU8: vi.fn((s: string) => new TextEncoder().encode(s)),
  mockZipSync: vi.fn(() => new Uint8Array([1, 2, 3])),
}));
vi.mock("fflate", () => ({ strToU8: mockStrToU8, zipSync: mockZipSync }));

const { mockGenerateScaffold } = vi.hoisted(() => ({
  mockGenerateScaffold: vi.fn(),
}));
vi.mock("../../../lib/scaffold", () => ({
  generateScaffold: mockGenerateScaffold,
}));

const { mockGenerateExportFilename, mockTriggerDownload } = vi.hoisted(() => ({
  mockGenerateExportFilename: vi.fn(
    (title: string, format: string) => `${title}.${format}`,
  ),
  mockTriggerDownload: vi.fn(),
}));
vi.mock("../../../lib/export", () => ({
  generateExportFilename: mockGenerateExportFilename,
  triggerDownload: mockTriggerDownload,
}));

const { useDiagramStore } = await import("../../../stores/diagramStore");
const { ExportButton } = await import("./ExportButton");

/** A worker node with a catalog `wranglerBinding`, so project export is enabled. */
const WORKER_NODE = {
  data: { label: "API Worker", typeId: "worker" },
  id: "n1",
  position: { x: 0, y: 0 },
};

describe("ExportButton", () => {
  let viewportEl: HTMLElement;

  beforeEach(() => {
    useDiagramStore.setState({
      diagramId: "d1",
      edges: [],
      nodes: [],
      title: "My Diagram",
    });
    mockXyflow.mockGetNodes.mockReset().mockReturnValue([]);
    mockXyflow.mockGetNodesBounds.mockReset().mockReturnValue({
      height: 300,
      width: 400,
      x: 0,
      y: 0,
    });
    mockXyflow.mockGetViewportForBounds
      .mockReset()
      .mockReturnValue({ x: 0, y: 0, zoom: 1 });
    mockToPng.mockReset().mockResolvedValue("data:image/png;base64,abc");
    mockToSvg.mockReset().mockResolvedValue("data:image/svg+xml;base64,abc");
    mockGenerateScaffold.mockReset().mockReturnValue(new Map());
    mockGenerateExportFilename.mockClear();
    mockTriggerDownload.mockClear();
    mockStrToU8.mockClear();
    mockZipSync.mockClear();

    viewportEl = document.createElement("div");
    viewportEl.className = "react-flow__viewport";
    document.body.appendChild(viewportEl);

    // jsdom has no real Blob/URL.createObjectURL by default in every environment; stub them so
    // the project-export path can run without throwing.
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn().mockReturnValue("blob:fake"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    viewportEl.remove();
    vi.unstubAllGlobals();
  });

  it("toggles the export menu open and closed", () => {
    render(<ExportButton />);

    expect(screen.queryByText("Export as PNG")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Export"));
    expect(screen.getByText("Export as PNG")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Export"));
    expect(screen.queryByText("Export as PNG")).not.toBeInTheDocument();
  });

  it("closes the menu when clicking outside it", () => {
    render(<ExportButton />);

    fireEvent.click(screen.getByTitle("Export"));
    expect(screen.getByText("Export as PNG")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Export as PNG")).not.toBeInTheDocument();
  });

  it("leaves the menu open when clicking inside it", () => {
    render(<ExportButton />);

    fireEvent.click(screen.getByTitle("Export"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("disables 'Export as project' when no node has a catalog wrangler binding", () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: "Browser", typeId: "client-browser" },
          id: "n1",
          position: { x: 0, y: 0 },
        },
      ],
    });
    render(<ExportButton />);

    fireEvent.click(screen.getByTitle("Export"));

    expect(screen.getByText("Export as project")).toBeDisabled();
  });

  it("enables 'Export as project' when a node has a catalog wrangler binding", () => {
    useDiagramStore.setState({ nodes: [WORKER_NODE] });
    render(<ExportButton />);

    fireEvent.click(screen.getByTitle("Export"));

    expect(screen.getByText("Export as project")).not.toBeDisabled();
  });

  it("does nothing for a PNG export when the canvas has no nodes", async () => {
    mockXyflow.mockGetNodes.mockReturnValue([]);
    render(<ExportButton />);

    fireEvent.click(screen.getByTitle("Export"));
    fireEvent.click(screen.getByText("Export as PNG"));

    await waitFor(() => expect(mockToPng).not.toHaveBeenCalled());
    expect(mockTriggerDownload).not.toHaveBeenCalled();
  });

  it("exports as PNG using the fitted viewport bounds", async () => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    render(<ExportButton />);

    fireEvent.click(screen.getByTitle("Export"));
    fireEvent.click(screen.getByText("Export as PNG"));

    await waitFor(() => expect(mockToPng).toHaveBeenCalledTimes(1));
    expect(mockToPng.mock.calls[0]?.[0]).toBe(viewportEl);
    expect(mockTriggerDownload).toHaveBeenCalledWith(
      "data:image/png;base64,abc",
      "My Diagram.png",
    );
  });

  it("exports as SVG", async () => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    render(<ExportButton />);

    fireEvent.click(screen.getByTitle("Export"));
    fireEvent.click(screen.getByText("Export as SVG"));

    await waitFor(() => expect(mockToSvg).toHaveBeenCalledTimes(1));
    expect(mockTriggerDownload).toHaveBeenCalledWith(
      "data:image/svg+xml;base64,abc",
      "My Diagram.svg",
    );
  });

  it("shows an alert and does not download when image capture fails", async () => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    mockToPng.mockRejectedValue(new Error("tainted canvas"));
    render(<ExportButton />);

    fireEvent.click(screen.getByTitle("Export"));
    fireEvent.click(screen.getByText("Export as PNG"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not export the diagram. Please try again.",
      ),
    );
    expect(mockTriggerDownload).not.toHaveBeenCalled();
  });

  it("skips the image capture entirely when the viewport element is missing", async () => {
    viewportEl.remove();
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    render(<ExportButton />);

    fireEvent.click(screen.getByTitle("Export"));
    fireEvent.click(screen.getByText("Export as PNG"));

    await waitFor(() => expect(mockToPng).not.toHaveBeenCalled());
    expect(mockTriggerDownload).not.toHaveBeenCalled();
  });

  it("exports a project scaffold ZIP, mapping node and edge data for the generator", () => {
    mockGenerateScaffold.mockReturnValue(new Map([["package.json", "{}"]]));
    useDiagramStore.setState({
      edges: [
        {
          data: { edgeType: "data-flow" },
          id: "e1",
          source: "n1",
          target: "n2",
        },
      ],
      nodes: [WORKER_NODE],
    });
    render(<ExportButton />);

    fireEvent.click(screen.getByTitle("Export"));
    fireEvent.click(screen.getByText("Export as project"));

    expect(mockGenerateScaffold).toHaveBeenCalledWith({
      edges: [{ edgeType: "data-flow", source: "n1", target: "n2" }],
      nodes: [{ label: "API Worker", typeId: "worker" }],
      title: "My Diagram",
    });
    expect(mockTriggerDownload).toHaveBeenCalledWith(
      "blob:fake",
      "My Diagram.zip",
    );
  });

  it("does nothing for a project export when the scaffold generator returns no files", () => {
    mockGenerateScaffold.mockReturnValue(new Map());
    useDiagramStore.setState({ nodes: [WORKER_NODE] });
    render(<ExportButton />);

    fireEvent.click(screen.getByTitle("Export"));
    fireEvent.click(screen.getByText("Export as project"));

    expect(mockTriggerDownload).not.toHaveBeenCalled();
  });
});
