import { strToU8, zipSync } from 'fflate';
import { toPng, toSvg } from 'html-to-image';
import { useCallback, useRef, useState } from 'react';
import { Download } from 'react-feather';
import { getViewportForBounds, useReactFlow } from '@xyflow/react';
import { NODE_TYPE_MAP } from '../../../../catalog.ts';
import { useDismissableMenu } from '../../../hooks/useDismissableMenu.ts';
import { generateExportFilename, triggerDownload } from '../../../lib/export.ts';
import { generateScaffold } from '../../../lib/scaffold.ts';
import { useDiagramStore } from '../../../stores/diagramStore.ts';

/**
 * Blank margin, in canvas pixels, left around the diagram in an exported image.
 *
 * Without it the outermost nodes sit flush against the edge, which reads as a cropped screenshot
 * rather than an exported diagram.
 */
const IMAGE_PADDING = 50;

/**
 * Smallest width or height, in pixels, an exported image is allowed to be.
 *
 * A two-node diagram would otherwise produce a thumbnail-sized file whose text is unreadable at
 * normal zoom.
 */
const MIN_DIMENSION = 400;

/**
 * Zoom bounds and padding the exported viewport is fitted within, matching what the canvas's own
 * fit-view would choose.
 */
const EXPORT_MIN_ZOOM = 0.5;
const EXPORT_MAX_ZOOM = 2;
const EXPORT_FIT_PADDING = 0.25;

/**
 * The export control: a menu offering PNG, SVG and a downloadable starter project.
 *
 * **Every export happens in the browser, and must.** PNG and SVG are rasterisations of what this
 * visitor's own browser laid out — fonts, computed colours, the current colour scheme — none of
 * which a Worker has a DOM to reproduce. That is a documented non-goal rather than a gap, and it is
 * why the later MCP layer exposes JSON and project exports but not these two.
 *
 * The image export does **not** capture what is on screen. It computes the diagram's own bounding
 * box and a matching transform, so the file contains the whole diagram neatly framed regardless of
 * where the visitor had panned or how far they had zoomed. Exporting a half-scrolled canvas is
 * almost never what somebody pressing this wanted.
 *
 * Rendered in both postures, including read-only. An anonymous visitor reading a shared diagram has
 * the same reason to want a PNG of it as its owner, and nothing here writes anything.
 *
 * @returns The export control and, while open, its menu.
 */
export function ExportButton() {
  const { getNodes, getNodesBounds } = useReactFlow();
  const title = useDiagramStore((state) => state.title);
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // A diagram of nothing but external actors has no Cloudflare service to configure, so there is
  // no project to generate. The option says so rather than downloading an empty one.
  //
  // Subscribed to, unlike the graph the export itself reads: this decides what the menu *looks*
  // like, so it has to re-render when the canvas changes rather than being read at the moment of
  // a press.
  const hasBindableNodes = useDiagramStore((state) =>
    state.nodes.some((node) => NODE_TYPE_MAP.get(node.data.typeId)?.wranglerBinding != null)
  );

  useDismissableMenu(
    open,
    wrapperRef,
    useCallback(() => setOpen(false), [])
  );

  /**
   * Captures the diagram as an image and downloads it.
   *
   * @param format Whether to produce a PNG or an SVG.
   * @returns A promise fulfilled once the download has been triggered or the failure reported.
   */
  const handleImageExport = useCallback(
    async (format: 'png' | 'svg') => {
      setOpen(false);
      setError(null);

      const flowNodes = getNodes();
      // Nothing to capture. Silently doing nothing is right here: the menu has already closed,
      // and an error about an empty diagram would be telling somebody what they can plainly see.
      if (flowNodes.length === 0) {
        return;
      }

      setExporting(true);
      try {
        const bounds = getNodesBounds(flowNodes);
        const width = Math.max(bounds.width + IMAGE_PADDING * 2, MIN_DIMENSION);
        const height = Math.max(bounds.height + IMAGE_PADDING * 2, MIN_DIMENSION);
        const viewport = getViewportForBounds(
          bounds,
          width,
          height,
          EXPORT_MIN_ZOOM,
          EXPORT_MAX_ZOOM,
          EXPORT_FIT_PADDING
        );

        // React Flow's transformed layer, rather than the canvas container: the container also
        // holds the background grid, the minimap and the controls, none of which belong in an
        // exported diagram.
        const viewportElement = document.querySelector<HTMLElement>('.react-flow__viewport');
        if (!viewportElement) {
          return;
        }

        const capture = format === 'png' ? toPng : toSvg;
        const dataUrl = await capture(viewportElement, {
          // A white background in both schemes. An exported diagram is normally pasted into a
          // document or a slide, and a dark-mode export arrives there as a black rectangle.
          backgroundColor: '#ffffff',
          height,
          style: {
            height: `${height}px`,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            width: `${width}px`
          },
          width
        });

        triggerDownload(dataUrl, generateExportFilename(title, format));
      } catch {
        // `html-to-image` fails on things the visitor cannot act on — an unsupported CSS value, a
        // canvas tainted by a cross-origin image — so the message offers the one thing that
        // sometimes helps rather than a cause nobody can use.
        setError('Could not export the diagram. Please try again.');
      } finally {
        // In a `finally` so a failed export re-enables the control rather than leaving the
        // toolbar with a permanently disabled button and no way to retry.
        setExporting(false);
      }
    },
    [getNodes, getNodesBounds, title]
  );

  /**
   * Generates a starter project from the diagram and downloads it as a ZIP.
   *
   * @returns Nothing. Synchronous: the generator is pure and the zip is built in memory, so there
   *   is nothing to await.
   */
  const handleProjectExport = useCallback(() => {
    setOpen(false);
    setError(null);
    setExporting(true);
    try {
      // Read at the moment of the press rather than captured when this callback was built, the
      // same way the editor's autosave reads the graph when its timer fires. The menu can sit
      // open while the canvas changes underneath it, and a project generated from the graph as
      // it stood when the menu opened would quietly omit whatever was added since.
      const state = useDiagramStore.getState();

      const files = generateScaffold({
        edges: state.edges.map((edge) => ({
          edgeType: edge.data?.edgeType,
          source: edge.source,
          target: edge.target
        })),
        nodes: state.nodes.map((node) => ({ label: node.data.label, typeId: node.data.typeId })),
        title: state.title
      });

      // The menu disables this option in the same case, so reaching here means the diagram
      // changed between opening the menu and choosing. Downloading an empty archive would be a
      // worse answer than doing nothing.
      if (files.size === 0) {
        return;
      }

      const zipData: Record<string, Uint8Array> = {};
      for (const [path, content] of files) {
        zipData[path] = strToU8(content);
      }

      const zipped = zipSync(zipData);
      const url = URL.createObjectURL(
        new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
      );
      triggerDownload(url, generateExportFilename(state.title, 'zip'));
      // Revoked immediately: the browser has already taken ownership of the download by the time
      // the click returns, and an object URL left alive pins the whole archive in memory for the
      // lifetime of the tab.
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, []);

  return (
    <div className="toolbar__export-group" ref={wrapperRef}>
      <button
        type="button"
        className="toolbar__button"
        title="Export"
        aria-label={exporting ? 'Exporting…' : 'Export'}
        disabled={exporting}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((previous) => !previous)}
      >
        <Download size={18} aria-hidden="true" />
      </button>
      {open && (
        <div className="toolbar__export-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="toolbar__export-option"
            onClick={() => void handleImageExport('png')}
          >
            Export as PNG
          </button>
          <button
            type="button"
            role="menuitem"
            className="toolbar__export-option"
            onClick={() => void handleImageExport('svg')}
          >
            Export as SVG
          </button>
          {/* Disabled rather than hidden, with a reason: an option that vanishes leaves somebody
              who used it last time wondering where it went. */}
          <button
            type="button"
            role="menuitem"
            className="toolbar__export-option"
            disabled={!hasBindableNodes}
            title={hasBindableNodes ? undefined : 'Add Cloudflare services to export a project'}
            onClick={handleProjectExport}
          >
            Export as project
          </button>
        </div>
      )}
      {/* Announced, because the press that caused it may have come from the keyboard and its only
          other evidence is a download that never started. */}
      {error && (
        <p className="toolbar__export-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
