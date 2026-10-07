import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as mockXyflow from './mock-xyflow.tsx';

vi.mock('@xyflow/react', () => mockXyflow);

const { mockToPng, mockToSvg } = vi.hoisted(() => ({
  mockToPng: vi.fn(),
  mockToSvg: vi.fn()
}));
vi.mock('html-to-image', () => ({ toPng: mockToPng, toSvg: mockToSvg }));

const { mockStrToU8, mockZipSync } = vi.hoisted(() => ({
  mockStrToU8: vi.fn((value: string) => new TextEncoder().encode(value)),
  mockZipSync: vi.fn(() => new Uint8Array([1, 2, 3]))
}));
vi.mock('fflate', () => ({ strToU8: mockStrToU8, zipSync: mockZipSync }));

const { mockGenerateScaffold } = vi.hoisted(() => ({ mockGenerateScaffold: vi.fn() }));
vi.mock('../../src/client/lib/scaffold.ts', () => ({ generateScaffold: mockGenerateScaffold }));

const { useDiagramStore } = await import('../../src/client/stores/diagramStore.ts');
const { ExportButton } =
  await import('../../src/client/components/editor/toolbar/ExportButton.tsx');

/**
 * @file Covers the export control. The image capture and the zip are both stubbed: this suite is
 *   about the component's decisions — which capture runs, what filename it asks for, when the
 *   project option is offered at all, and how a failure is reported — rather than about
 *   `html-to-image` producing a correct PNG, which jsdom could not render anyway.
 */

/**
 * A Workers node, whose catalogue entry names a binding kind, so the project option is enabled.
 */
const WORKER_NODE = {
  data: { label: 'API Worker', typeId: 'worker' },
  id: 'n1',
  position: { x: 0, y: 0 },
  type: 'cf-node'
};

/**
 * React Flow's transformed layer, which the capture targets.
 */
let viewportElement: HTMLElement;

beforeEach(() => {
  useDiagramStore.setState({ diagramId: 'd1', edges: [], nodes: [], title: 'My Diagram' });

  mockXyflow.mockGetNodes.mockReset().mockReturnValue([]);
  mockXyflow.mockGetNodesBounds.mockReset().mockReturnValue({
    height: 300,
    width: 400,
    x: 0,
    y: 0
  });
  mockXyflow.mockGetViewportForBounds.mockReset().mockReturnValue({ x: 0, y: 0, zoom: 1 });
  mockToPng.mockReset().mockResolvedValue('data:image/png;base64,abc');
  mockToSvg.mockReset().mockResolvedValue('data:image/svg+xml;base64,abc');
  mockGenerateScaffold.mockReset().mockReturnValue(new Map());
  mockStrToU8.mockClear();
  mockZipSync.mockClear();

  viewportElement = document.createElement('div');
  viewportElement.className = 'react-flow__viewport';
  document.body.appendChild(viewportElement);

  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn().mockReturnValue('blob:generated'),
    revokeObjectURL: vi.fn()
  });
});

afterEach(() => {
  viewportElement.remove();
  vi.unstubAllGlobals();
  // The download spies are installed on `HTMLAnchorElement.prototype`, which is shared across
  // every test in the file. Without this, a spy left in place by one test keeps counting calls
  // made by the next and a "did not download" assertion fails against somebody else's export.
  vi.restoreAllMocks();
});

/**
 * Opens the export menu.
 */
function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
}

describe('the menu', () => {
  it('is closed until the control is pressed', () => {
    render(<ExportButton />);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('opens and closes on the control', () => {
    render(<ExportButton />);

    openMenu();

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toHaveAttribute('aria-expanded', 'true');

    openMenu();

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('offers the three exports', () => {
    render(<ExportButton />);
    openMenu();

    for (const name of ['Export as PNG', 'Export as SVG', 'Export as project']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
  });

  it('closes on an outside press', () => {
    render(<ExportButton />);
    openMenu();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('stays open on a press inside it', () => {
    render(<ExportButton />);
    openMenu();

    fireEvent.mouseDown(screen.getByRole('menu'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  // Without this a keyboard-only visitor has no way to dismiss the menu: they can tab away, but
  // it stays visibly open over whatever they moved to.
  it('closes on Escape', () => {
    render(<ExportButton />);
    openMenu();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes behind the choice rather than staying open over the result', async () => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PNG' }));

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});

describe('exporting an image', () => {
  it.each([
    ['PNG', 'Export as PNG', (): unknown => mockToPng, 'data:image/png;base64,abc', 'png'],
    ['SVG', 'Export as SVG', (): unknown => mockToSvg, 'data:image/svg+xml;base64,abc', 'svg']
  ])('captures and downloads a %s', async (_format, item, capture, dataUrl, extension) => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const append = vi.spyOn(document.body, 'appendChild');
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: item }));

    await waitFor(() => expect(capture()).toHaveBeenCalledTimes(1));
    expect(click).toHaveBeenCalled();

    const anchor = append.mock.calls
      .map(([node]) => node)
      .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);

    expect(anchor?.href).toBe(dataUrl);
    expect(anchor?.download).toMatch(new RegExp(`^My_Diagram_.*\\.${extension}$`, 'u'));

    click.mockRestore();
    append.mockRestore();
  });

  // The transformed layer, not the canvas container: the container also holds the background
  // grid, the minimap and the controls, none of which belongs in an exported diagram.
  it('captures React Flow\u2019s transformed layer rather than the whole canvas', async () => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PNG' }));

    await waitFor(() => expect(mockToPng).toHaveBeenCalled());
    expect(mockToPng.mock.calls[0]?.[0]).toBe(viewportElement);
  });

  // The export frames the whole diagram regardless of where the visitor had panned, so the
  // transform comes from the diagram's own bounds rather than from the current viewport.
  it('frames the diagram from its own bounds rather than the current view', async () => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    mockXyflow.mockGetViewportForBounds.mockReturnValue({ x: 12, y: 34, zoom: 2 });
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PNG' }));

    await waitFor(() => expect(mockXyflow.mockGetNodesBounds).toHaveBeenCalled());
    expect(mockToPng.mock.calls[0]?.[1]).toMatchObject({
      style: expect.objectContaining({ transform: 'translate(12px, 34px) scale(2)' })
    });
  });

  // An exported diagram is normally pasted into a document or a slide, where a dark-mode export
  // arrives as a black rectangle.
  it('exports on a white background in either colour scheme', async () => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PNG' }));

    await waitFor(() => expect(mockToPng).toHaveBeenCalled());
    expect(mockToPng.mock.calls[0]?.[1]).toMatchObject({ backgroundColor: '#ffffff' });
  });

  // A tiny diagram would otherwise produce a thumbnail-sized file whose text is unreadable.
  it('never shrinks the exported image below its floor', async () => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    mockXyflow.mockGetNodesBounds.mockReturnValue({ height: 10, width: 10, x: 0, y: 0 });
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PNG' }));

    await waitFor(() => expect(mockToPng).toHaveBeenCalled());

    const options = mockToPng.mock.calls[0]?.[1] as { height: number; width: number };

    expect(options.width).toBeGreaterThanOrEqual(400);
    expect(options.height).toBeGreaterThanOrEqual(400);
  });

  it('leaves a margin around the diagram', async () => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    mockXyflow.mockGetNodesBounds.mockReturnValue({ height: 1_000, width: 1_000, x: 0, y: 0 });
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PNG' }));

    await waitFor(() => expect(mockToPng).toHaveBeenCalled());
    expect(mockToPng.mock.calls[0]?.[1]).toMatchObject({ height: 1_100, width: 1_100 });
  });

  // Silently, because the menu has already closed and an error about an empty diagram would be
  // telling somebody what they can plainly see.
  it('does nothing for an empty diagram', async () => {
    mockXyflow.mockGetNodes.mockReturnValue([]);
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PNG' }));

    await waitFor(() => expect(mockToPng).not.toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does nothing when the canvas layer is not in the document', async () => {
    viewportElement.remove();
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PNG' }));

    await waitFor(() => expect(mockToPng).not.toHaveBeenCalled());
  });

  // Announced, because the press may have come from the keyboard and its only other evidence is
  // a download that never started.
  it('reports a failed capture', async () => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    mockToPng.mockRejectedValue(new Error('tainted canvas'));
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PNG' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not export the diagram. Please try again.'
      )
    );
  });

  // A failed export must leave a control that can be pressed again rather than a permanently
  // dead one.
  it('stays usable after a failure', async () => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    mockToPng.mockRejectedValue(new Error('tainted canvas'));
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PNG' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('clears a previous failure when a later export succeeds', async () => {
    mockXyflow.mockGetNodes.mockReturnValue([WORKER_NODE]);
    mockToPng.mockRejectedValueOnce(new Error('tainted canvas'));
    render(<ExportButton />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PNG' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as PNG' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

describe('exporting a project', () => {
  it('generates from the diagram\u2019s nodes and edges and downloads a zip', () => {
    mockGenerateScaffold.mockReturnValue(new Map([['package.json', '{}']]));
    useDiagramStore.setState({
      edges: [{ data: { edgeType: 'data-flow' }, id: 'e1', source: 'n1', target: 'n2' }],
      nodes: [WORKER_NODE]
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const append = vi.spyOn(document.body, 'appendChild');
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as project' }));

    expect(mockGenerateScaffold).toHaveBeenCalledWith({
      edges: [{ edgeType: 'data-flow', source: 'n1', target: 'n2' }],
      nodes: [{ label: 'API Worker', typeId: 'worker' }],
      title: 'My Diagram'
    });

    const anchor = append.mock.calls
      .map(([node]) => node)
      .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);

    expect(anchor?.download).toMatch(/^My_Diagram_.*\.zip$/u);
    expect(click).toHaveBeenCalled();

    click.mockRestore();
    append.mockRestore();
  });

  // The menu can sit open while the canvas changes underneath it, so the graph is read at the
  // moment of the press rather than when the callback was built — the same rule the editor's
  // autosave follows. A project generated from the older graph would quietly omit whatever was
  // added since.
  it('generates from the graph as it stands when the option is chosen', () => {
    mockGenerateScaffold.mockReturnValue(new Map([['package.json', '{}']]));
    useDiagramStore.setState({ nodes: [WORKER_NODE] });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ExportButton />);
    openMenu();

    useDiagramStore.setState({
      nodes: [
        WORKER_NODE,
        {
          data: { label: 'Main Database', typeId: 'd1' },
          id: 'n2',
          position: { x: 0, y: 0 },
          type: 'cf-node'
        }
      ],
      title: 'Renamed Diagram'
    });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as project' }));

    expect(mockGenerateScaffold).toHaveBeenCalledWith(
      expect.objectContaining({
        nodes: [
          { label: 'API Worker', typeId: 'worker' },
          { label: 'Main Database', typeId: 'd1' }
        ],
        title: 'Renamed Diagram'
      })
    );
  });

  // An object URL left alive pins the whole archive in memory for the lifetime of the tab.
  it('releases the object url once the download has started', () => {
    mockGenerateScaffold.mockReturnValue(new Map([['package.json', '{}']]));
    useDiagramStore.setState({ nodes: [WORKER_NODE] });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as project' }));

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:generated');
  });

  // A diagram of nothing but external actors has no Cloudflare service to configure, so there is
  // no project to generate. Disabled rather than hidden, with a reason: an option that vanishes
  // leaves somebody who used it last time wondering where it went.
  it('is unavailable, with a reason, when nothing on the canvas is a Cloudflare service', () => {
    useDiagramStore.setState({
      nodes: [
        {
          data: { label: 'Browser', typeId: 'client-browser' },
          id: 'n1',
          position: { x: 0, y: 0 },
          type: 'cf-node'
        }
      ]
    });
    render(<ExportButton />);
    openMenu();

    const option = screen.getByRole('menuitem', { name: 'Export as project' });

    expect(option).toBeDisabled();
    expect(option).toHaveAttribute('title', 'Add Cloudflare services to export a project');
  });

  it('is available once a Cloudflare service is on the canvas', () => {
    useDiagramStore.setState({ nodes: [WORKER_NODE] });
    render(<ExportButton />);
    openMenu();

    expect(screen.getByRole('menuitem', { name: 'Export as project' })).toBeEnabled();
  });

  // Downloading an empty archive would be a worse answer than doing nothing.
  it('downloads nothing when the generator produced no files', () => {
    mockGenerateScaffold.mockReturnValue(new Map());
    useDiagramStore.setState({ nodes: [WORKER_NODE] });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ExportButton />);
    openMenu();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as project' }));

    expect(click).not.toHaveBeenCalled();
    expect(mockZipSync).not.toHaveBeenCalled();

    click.mockRestore();
  });
});
