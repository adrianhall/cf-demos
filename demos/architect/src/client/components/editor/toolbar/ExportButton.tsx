import {
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
} from "@xyflow/react";
import { strToU8, zipSync } from "fflate";
import { toPng, toSvg } from "html-to-image";
import { useCallback, useRef, useState } from "react";
import { Download } from "react-feather";
import { NODE_TYPE_MAP } from "../../../../catalog";
import { useDismissableMenu } from "../../../hooks/useDismissableMenu";
import { generateExportFilename, triggerDownload } from "../../../lib/export";
import { generateScaffold } from "../../../lib/scaffold";
import { useDiagramStore } from "../../../stores/diagramStore";

/** Blank margin, in canvas pixels, added around the diagram bounds before rasterizing. */
const IMAGE_PADDING = 50;
/** Smallest width/height, in pixels, the exported PNG/SVG canvas is ever allowed to shrink to. */
const MIN_DIMENSION = 400;

/**
 * Toolbar control with a three-option menu (PNG / SVG / Project) for exporting the current
 * diagram. Ported from CF-Architect's `src/islands/toolbar/ExportButton.tsx`
 * (docs/09-ARCHITECT.md Phase 5).
 *
 * PNG and SVG capture the React Flow viewport element directly with `html-to-image`, computing a
 * tight bounding box and matching zoom/pan transform from the current node positions so the
 * export matches what auto-fit-view would show, independent of the canvas's current on-screen
 * pan/zoom. Project generates a downloadable `wrangler.toml`-based starter project ZIP via
 * `../../../lib/scaffold.ts` and `fflate` — disabled when the diagram has no node with a
 * catalog `wranglerBinding` (docs/09-ARCHITECT.md's Data Model), since there would be nothing to
 * scaffold.
 *
 * Rendered unconditionally, including in read-only mode (`../DiagramCanvas.tsx`) — an anonymous
 * share viewer can export or generate a project from a diagram it cannot edit, matching
 * CF-Architect's own toolbar, which renders `ExportButton` regardless of `readOnly`.
 */
export function ExportButton() {
  const { getNodes } = useReactFlow();
  const { title, nodes, edges } = useDiagramStore();
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const hasCloudflareNodes = nodes.some(
    (node) => NODE_TYPE_MAP.get(node.data.typeId)?.wranglerBinding != null,
  );

  useDismissableMenu(
    open,
    wrapperRef,
    useCallback(() => setOpen(false), []),
  );

  /** Rasterize the current viewport to PNG or SVG and download it. */
  const handleImageExport = useCallback(
    async (format: "png" | "svg") => {
      setOpen(false);
      setError(null);

      const flowNodes = getNodes();
      if (flowNodes.length === 0) return;

      setExporting(true);
      try {
        const bounds = getNodesBounds(flowNodes);
        const width = Math.max(bounds.width + IMAGE_PADDING * 2, MIN_DIMENSION);
        const height = Math.max(
          bounds.height + IMAGE_PADDING * 2,
          MIN_DIMENSION,
        );
        const viewport = getViewportForBounds(
          bounds,
          width,
          height,
          0.5,
          2,
          0.25,
        );

        const viewportEl = document.querySelector<HTMLElement>(
          ".react-flow__viewport",
        );
        if (!viewportEl) return;

        const capture = format === "png" ? toPng : toSvg;
        const dataUrl = await capture(viewportEl, {
          backgroundColor: "#ffffff",
          height,
          style: {
            height: `${height}px`,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
            width: `${width}px`,
          },
          width,
        });

        triggerDownload(dataUrl, generateExportFilename(title, format));
      } catch {
        // `html-to-image` failures (unsupported CSS, a tainted canvas) are environment-dependent
        // and not something the user can act on beyond retrying.
        setError("Could not export the diagram. Please try again.");
      } finally {
        setExporting(false);
      }
    },
    [getNodes, title],
  );

  /** Generate a project scaffold ZIP from the current graph and download it. */
  const handleProjectExport = useCallback(() => {
    setOpen(false);
    setError(null);
    setExporting(true);
    try {
      const files = generateScaffold({
        edges: edges.map((edge) => ({
          edgeType: edge.data?.edgeType,
          source: edge.source,
          target: edge.target,
        })),
        nodes: nodes.map((node) => ({
          label: node.data.label,
          typeId: node.data.typeId,
        })),
        title,
      });
      if (files.size === 0) return;

      const zipData: Record<string, Uint8Array> = {};
      for (const [path, content] of files) {
        zipData[path] = strToU8(content);
      }

      const zipped = zipSync(zipData);
      const blob = new Blob([zipped.buffer as ArrayBuffer], {
        type: "application/zip",
      });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, generateExportFilename(title, "zip"));
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [nodes, edges, title]);

  return (
    <div className="toolbar__export-group" ref={wrapperRef}>
      <button
        type="button"
        className="toolbar__button"
        title="Export"
        aria-label={exporting ? "Exporting…" : "Export"}
        disabled={exporting}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((prev) => !prev)}
      >
        <Download size={18} aria-hidden="true" />
      </button>
      {open && (
        <div className="toolbar__export-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="toolbar__export-option"
            onClick={() => void handleImageExport("png")}
          >
            Export as PNG
          </button>
          <button
            type="button"
            role="menuitem"
            className="toolbar__export-option"
            onClick={() => void handleImageExport("svg")}
          >
            Export as SVG
          </button>
          <button
            type="button"
            role="menuitem"
            className="toolbar__export-option"
            disabled={!hasCloudflareNodes}
            title={
              hasCloudflareNodes
                ? undefined
                : "Add Cloudflare services to export a project"
            }
            onClick={handleProjectExport}
          >
            Export as project
          </button>
        </div>
      )}
      {error && (
        <p className="toolbar__export-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
