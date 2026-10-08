import { CATEGORY_COLORS, EDGE_TYPE_MAP, NODE_TYPE_MAP } from '../../catalog.ts';
import type { GraphData } from './graph.ts';

/**
 * @file A pure {@link GraphData} → SVG transform. Pure in the same sense `./graph-mutations.ts` is
 *   pure: no binding, no fetch, no storage, and — the point of this module — no DOM. It is a string
 *   builder over the canonical graph shape and the product catalogue, so it runs in `workerd`, in
 *   Node and in a browser identically, and every transport that has to draw a graph can produce the
 *   same picture rather than each inventing one. **This is a deliberate, documented divergence from
 *   `09B-ARCHITECT-MCP.md`'s Non-Goals**, which excluded "Raster (PNG/SVG) export from the remote
 *   MCP server". That exclusion was argued entirely from one premise — the editor's export
 *   rasterises the live React Flow canvas with `html-to-image`, and a Worker has no DOM to
 *   rasterise — and the premise is true. It simply does not reach a _vector_ transform, which
 *   rasterises nothing: SVG is markup, and markup describing a graph can be written from the graph.
 *   PNG stays out of scope for exactly the original reason, because turning markup into pixels does
 *   need a renderer. The output is deliberately **not** a pixel-identical reproduction of the
 *   editor's own SVG export. That file is a capture of one visitor's browser — their fonts, their
 *   colour scheme, their computed styles — and nothing here can or should reconstruct it. What this
 *   produces is the same _architecture_, drawn from the same catalogue: the same category colours,
 *   the same four edge treatments, the same labels, at the same canvas coordinates. Correctness and
 *   legibility are the standard here, not fidelity.
 */

/**
 * Rendered width of every node box, in canvas units.
 *
 * Fixed rather than measured. Measuring would need text metrics, which need a DOM — and a uniform
 * width reads better anyway at the spacings the blueprints and `autoLayout`
 * (`./graph-mutations.ts`) actually use, where a row of differently-sized boxes looks like a
 * mistake rather than a hierarchy.
 */
const NODE_WIDTH = 200;

/**
 * Height of a node's coloured header band, which holds the swatch and the node's own label.
 */
const HEADER_HEIGHT = 34;

/**
 * Height of one line in a node's body: the product name, and the description when present.
 */
const BODY_LINE = 20;

/**
 * Blank margin left around the drawing's content extents, in canvas units.
 *
 * The editor's own image export leaves the same kind of margin, and for the same reason: without it
 * the outermost nodes sit flush against the edge, which reads as a cropped screenshot rather than
 * an exported diagram.
 */
const CANVAS_PADDING = 48;

/**
 * Corner radius used where an edge's orthogonal path turns.
 *
 * Matches the `borderRadius: 8` the editor passes to React Flow's `getSmoothStepPath`
 * (`../../client/components/editor/edges/CFEdge.tsx`), so a connection bends the same way here as
 * it does on the canvas.
 */
const EDGE_CORNER_RADIUS = 8;

/**
 * Stroke colour for an edge whose `edgeType` the catalogue does not define.
 *
 * The same grey `CFEdge.tsx` falls back to, so a legacy edge still reads as a connection here
 * rather than vanishing from the picture.
 */
const FALLBACK_EDGE_COLOR = '#9CA3AF';

/**
 * Approximate width of one glyph as a fraction of the font size.
 *
 * There is no DOM, so there is no way to measure text — this is the one place the transform
 * estimates rather than computes. 0.58 is a conservative figure for a humanist sans-serif at these
 * sizes: it over-estimates narrow strings slightly, so {@link truncateToWidth} trims a little sooner
 * than strictly necessary rather than letting a long label run outside its box, which is the
 * failure that actually looks broken.
 */
const GLYPH_WIDTH_RATIO = 0.58;

/**
 * Font stack applied to every piece of text in the output.
 *
 * A generic stack, not a web font. An exported SVG is read wherever it is embedded — a README on
 * any host, a slide, a wiki — so a font reference it cannot resolve would silently change the
 * drawing's metrics. Every family here is one the reader's own system already has.
 */
const FONT_STACK = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';

/**
 * One React Flow node as this module reads it.
 *
 * Only the fields the drawing needs are named, for the same reason `./graph-mutations.ts` names
 * only the fields it writes: the node vocabulary belongs to the editor, and a renderer that
 * demanded a complete shape would refuse to draw a graph the application is perfectly happy to
 * store.
 */
interface RenderableNode extends Record<string, unknown> {
  /**
   * Unique node id, the one field `./graph.ts` guarantees.
   */
  id: string;
  /**
   * Canvas position in flow coordinates. Absent on a hand-assembled graph, in which case the node
   * is drawn at the origin rather than dropped.
   */
  position?: { x?: unknown; y?: unknown };
  /**
   * Node data payload — the catalogue type, the user's label and an optional description.
   */
  data?: { typeId?: unknown; label?: unknown; description?: unknown };
}

/**
 * One React Flow edge as this module reads it, symmetric to {@link RenderableNode}.
 */
interface RenderableEdge extends Record<string, unknown> {
  /**
   * Unique edge id.
   */
  id: string;
  /**
   * Id of the node this edge leaves.
   */
  source?: unknown;
  /**
   * Id of the node this edge reaches.
   */
  target?: unknown;
  /**
   * Edge data payload — the catalogue edge type and an optional midpoint label.
   */
  data?: { edgeType?: unknown; label?: unknown };
}

/**
 * A node's resolved box and the text drawn inside it.
 */
interface NodeBox {
  /**
   * Left edge in canvas coordinates.
   */
  x: number;
  /**
   * Top edge in canvas coordinates.
   */
  y: number;
  /**
   * Box height, which depends only on whether the node carries a description.
   */
  height: number;
  /**
   * Category colour used for the border, the header tint and the swatch.
   */
  color: string;
  /**
   * The node's own label — free text, written by a person or by an agent.
   */
  label: string;
  /**
   * Catalogue product name, for example `Workers`, or the raw `typeId` when the catalogue has no
   * entry for it.
   */
  product: string;
  /**
   * Free-text annotation, or an empty string when the node has none.
   */
  description: string;
}

/**
 * Escapes text for inclusion in XML character data or in a double-quoted attribute value.
 *
 * **This is the module's one security-relevant function.** Every string it is given — a node label,
 * a description, an edge label, a diagram title — is user-controlled and ends up inside a document
 * the caller may embed in a page, a README renderer or an SVG viewer. An unescaped `<` does not
 * merely draw wrongly; it closes the text element and opens whatever the author wrote next, which
 * in an SVG that a browser loads inline is script execution. Escaping the full set rather than only
 * `<` and `&` means the same function is safe in both positions, so no call site has to decide
 * which escaping it needs.
 *
 * @param value Raw text, from diagram data or from a caller.
 * @returns The text with `&`, `<`, `>`, `"` and `'` replaced by their XML entities. `&` is replaced
 *   first, so the ampersands introduced by the later replacements are not escaped twice.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/**
 * Trims text to what fits in a given width at a given font size, appending an ellipsis when it had
 * to cut.
 *
 * Estimated rather than measured; see {@link GLYPH_WIDTH_RATIO} for why, and for which direction
 * the estimate errs in.
 *
 * @param value Text to fit.
 * @param maxWidth Space available, in canvas units.
 * @param fontSize Size the text will be drawn at.
 * @returns The text unchanged when it fits, otherwise a prefix ending in `…`.
 */
function truncateToWidth(value: string, maxWidth: number, fontSize: number): string {
  const perGlyph = fontSize * GLYPH_WIDTH_RATIO;
  const limit = Math.floor(maxWidth / perGlyph);

  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(limit - 1, 0))}\u2026`;
}

/**
 * Reads a coordinate from a node's position, defaulting a missing or non-numeric one to zero.
 *
 * `./graph.ts` validates only that a node is an object with an id, so a graph assembled by hand or
 * written by an older client can legitimately arrive without a position. Drawing it at the origin
 * keeps it in the picture; dropping it would quietly produce a diagram missing a service.
 *
 * @param value Candidate coordinate.
 * @returns The coordinate, or `0` when it is absent or not a finite number.
 */
function coordinate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Reads a string field from a node or edge payload, defaulting anything else to an empty string.
 *
 * @param value Candidate field value.
 * @returns The string, or `''`.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Resolves every node into the box the renderer draws.
 *
 * @param graph Graph being rendered.
 * @returns One {@link NodeBox} per node, keyed by node id, in the graph's own order. A duplicate id
 *   cannot occur in a stored graph, and the later entry would simply win if one did.
 */
function layoutNodes(graph: GraphData): Map<string, NodeBox> {
  const boxes = new Map<string, NodeBox>();

  for (const raw of graph.nodes as RenderableNode[]) {
    const typeId = text(raw.data?.typeId);
    const definition = NODE_TYPE_MAP.get(typeId);
    // `external` is the same fallback category `CFNode.tsx` uses for an unknown `typeId`, so a
    // product renamed out of the catalogue draws in the neutral grey rather than losing its border.
    const category = definition?.category ?? 'external';
    const description = text(raw.data?.description);

    boxes.set(raw.id, {
      color: CATEGORY_COLORS[category],
      description,
      height: HEADER_HEIGHT + BODY_LINE + (description === '' ? 0 : BODY_LINE),
      label: text(raw.data?.label) || raw.id,
      product: definition?.label ?? typeId,
      x: coordinate(raw.position?.x),
      y: coordinate(raw.position?.y)
    });
  }

  return boxes;
}

/**
 * Draws one node: its border, its tinted header, its category swatch and its text.
 *
 * The header's rounded top corners are drawn as an explicit path rather than as a rounded
 * rectangle. A `<rect rx="6">` would round the header's _bottom_ corners too, leaving two white
 * notches where it meets the body.
 *
 * @param box Resolved geometry and text for the node.
 * @returns The node's SVG fragment, with every piece of text escaped.
 */
function renderNode(box: NodeBox): string {
  const { color, height, x, y } = box;
  const radius = 6;
  const swatch = 14;
  const labelX = x + 12 + swatch + 8;

  const parts = [
    `<rect x="${x}" y="${y}" width="${NODE_WIDTH}" height="${height}" rx="${radius}" `
      + `fill="#ffffff" stroke="${color}" stroke-width="2"/>`,
    // Top-rounded band only: across the top edge, down the right side to the header's base, back
    // along it, and up the left side.
    `<path d="M ${x} ${y + HEADER_HEIGHT} L ${x} ${y + radius} `
      + `Q ${x} ${y} ${x + radius} ${y} L ${x + NODE_WIDTH - radius} ${y} `
      + `Q ${x + NODE_WIDTH} ${y} ${x + NODE_WIDTH} ${y + radius} `
      + `L ${x + NODE_WIDTH} ${y + HEADER_HEIGHT} Z" fill="${color}" fill-opacity="0.1"/>`,
    `<rect x="${x + 12}" y="${y + 10}" width="${swatch}" height="${swatch}" rx="3" `
      + `fill="${color}"/>`,
    `<text x="${labelX}" y="${y + 22}" font-size="13" font-weight="600" fill="#1a1a1a">`
      + `${escapeXml(truncateToWidth(box.label, x + NODE_WIDTH - 12 - labelX, 13))}</text>`,
    `<text x="${x + 12}" y="${y + HEADER_HEIGHT + 14}" font-size="11" fill="#555555">`
      + `${escapeXml(truncateToWidth(box.product, NODE_WIDTH - 24, 11))}</text>`
  ];

  if (box.description !== '') {
    parts.push(
      `<text x="${x + 12}" y="${y + HEADER_HEIGHT + BODY_LINE + 14}" font-size="11" `
        + `fill="#777777">`
        + `${escapeXml(truncateToWidth(box.description, NODE_WIDTH - 24, 11))}</text>`
    );
  }

  return parts.join('');
}

/**
 * A point on a node's boundary where an edge attaches.
 */
interface Anchor {
  /**
   * Horizontal position in canvas coordinates.
   */
  x: number;
  /**
   * Vertical position in canvas coordinates.
   */
  y: number;
  /**
   * Which way the edge leaves or arrives, which decides how the path turns.
   */
  axis: 'horizontal' | 'vertical';
}

/**
 * The two endpoints of one edge and the point its label sits on.
 */
interface EdgeGeometry {
  /**
   * Path data for the edge's own stroke.
   */
  path: string;
  /**
   * Midpoint of the elbow, where a label is centred.
   */
  labelX: number;
  /**
   * Vertical centre of the label.
   */
  labelY: number;
}

/**
 * Chooses which sides of two boxes an edge should connect, and routes an orthogonal path between
 * them.
 *
 * React Flow picks sides from the handles the user actually dragged between; a stored graph does
 * not record that, so the side is derived from the boxes' relative positions instead. Whichever
 * axis separates the two centres more is the axis the edge travels along, which produces the
 * vertical top-to-bottom flow the blueprints are drawn in and a sideways route for anything placed
 * beside rather than below.
 *
 * @param source Box the edge leaves.
 * @param target Box the edge reaches.
 * @returns The path and the label anchor.
 */
function routeEdge(source: NodeBox, target: NodeBox): EdgeGeometry {
  const sourceCentre = { x: source.x + NODE_WIDTH / 2, y: source.y + source.height / 2 };
  const targetCentre = { x: target.x + NODE_WIDTH / 2, y: target.y + target.height / 2 };
  const dx = targetCentre.x - sourceCentre.x;
  const dy = targetCentre.y - sourceCentre.y;

  let from: Anchor;
  let to: Anchor;
  if (Math.abs(dx) > Math.abs(dy)) {
    const leaving = dx > 0 ? source.x + NODE_WIDTH : source.x;
    const arriving = dx > 0 ? target.x : target.x + NODE_WIDTH;
    from = { axis: 'horizontal', x: leaving, y: sourceCentre.y };
    to = { axis: 'horizontal', x: arriving, y: targetCentre.y };
  } else {
    const leaving = dy > 0 ? source.y + source.height : source.y;
    const arriving = dy > 0 ? target.y : target.y + target.height;
    from = { axis: 'vertical', x: sourceCentre.x, y: leaving };
    to = { axis: 'vertical', x: targetCentre.x, y: arriving };
  }

  const midX = from.axis === 'horizontal' ? (from.x + to.x) / 2 : from.x;
  const midY = from.axis === 'horizontal' ? from.y : (from.y + to.y) / 2;

  return {
    labelX: from.axis === 'horizontal' ? midX : (from.x + to.x) / 2,
    labelY: from.axis === 'horizontal' ? (from.y + to.y) / 2 : midY,
    path: elbowPath(from, to)
  };
}

/**
 * Builds a two-corner orthogonal path with rounded turns between two anchors.
 *
 * A straight line is emitted when the two anchors already share the travelling axis' cross
 * coordinate, because a path that turns twice by zero degrees draws a visible kink at these corner
 * radii.
 *
 * @param from Anchor the path starts at.
 * @param to Anchor the path ends at.
 * @returns SVG path data.
 */
function elbowPath(from: Anchor, to: Anchor): string {
  if (from.axis === 'horizontal') {
    if (from.y === to.y) {
      return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
    }
    const mid = (from.x + to.x) / 2;
    // Horizontal anchors are chosen from opposite sides of two distinct boxes, so `to.x - from.x`
    // cannot be zero here.
    const stepX = Math.sign(to.x - from.x);
    const stepY = Math.sign(to.y - from.y);
    // Each corner is clipped by at most the radius, and never by more than half the leg it sits
    // on, so two corners on a short leg cannot overshoot each other and double back.
    const radius = Math.min(
      EDGE_CORNER_RADIUS,
      Math.abs(mid - from.x),
      Math.abs(to.y - from.y) / 2
    );
    return (
      `M ${from.x} ${from.y} L ${mid - stepX * radius} ${from.y} `
      + `Q ${mid} ${from.y} ${mid} ${from.y + stepY * radius} `
      + `L ${mid} ${to.y - stepY * radius} `
      + `Q ${mid} ${to.y} ${mid + stepX * radius} ${to.y} L ${to.x} ${to.y}`
    );
  }

  if (from.x === to.x) {
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  }
  const mid = (from.y + to.y) / 2;
  // Vertical anchors are chosen from opposite sides of two distinct boxes, so this delta is nonzero.
  const stepY = Math.sign(to.y - from.y);
  const stepX = Math.sign(to.x - from.x);
  const radius = Math.min(EDGE_CORNER_RADIUS, Math.abs(mid - from.y), Math.abs(to.x - from.x) / 2);
  return (
    `M ${from.x} ${from.y} L ${from.x} ${mid - stepY * radius} `
    + `Q ${from.x} ${mid} ${from.x + stepX * radius} ${mid} `
    + `L ${to.x - stepX * radius} ${mid} `
    + `Q ${to.x} ${mid} ${to.x} ${mid + stepY * radius} L ${to.x} ${to.y}`
  );
}

/**
 * Builds an arrowhead marker definition for one edge colour.
 *
 * One marker per distinct colour rather than per edge: a document with forty data-flow edges needs
 * one orange arrowhead, not forty identical ones.
 *
 * @param id Marker id, referenced by the edges that use it.
 * @param color Fill colour, matching the stroke of the edges referencing it.
 * @returns The `<marker>` element.
 */
function renderMarker(id: string, color: string): string {
  return (
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" `
    + `orient="auto-start-reverse" markerUnits="strokeWidth">`
    + `<path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker>`
  );
}

/**
 * A label drawn on top of an edge, once every edge stroke is down.
 */
interface EdgeLabel {
  /**
   * Horizontal centre in canvas coordinates.
   */
  x: number;
  /**
   * Vertical centre in canvas coordinates.
   */
  y: number;
  /**
   * The label text, not yet escaped.
   */
  value: string;
}

/**
 * Draws an edge label as a bordered chip, mirroring `.cf-edge__label` in `../../client/app.css`.
 *
 * The chip exists so the text stays readable where it crosses its own edge's stroke. Its width is
 * estimated from the text, for the reason {@link GLYPH_WIDTH_RATIO} explains.
 *
 * @param label Position and text.
 * @returns The chip and its text, with the text escaped.
 */
function renderEdgeLabel(label: EdgeLabel): string {
  const fontSize = 10;
  const value = truncateToWidth(label.value, 150, fontSize);
  const width = value.length * fontSize * GLYPH_WIDTH_RATIO + 10;
  const height = 16;

  return (
    `<rect x="${round(label.x - width / 2)}" y="${round(label.y - height / 2)}" `
    + `width="${round(width)}" height="${height}" rx="3" fill="#ffffff" stroke="#e5e5e5"/>`
    + `<text x="${round(label.x)}" y="${round(label.y + 3.5)}" font-size="${fontSize}" `
    + `fill="#444444" text-anchor="middle">${escapeXml(value)}</text>`
  );
}

/**
 * Rounds a computed coordinate to two decimal places.
 *
 * Midpoints and radii divide by two, and an un-rounded one can serialise as `312.50000000000006`.
 * Rounding keeps the document readable and, because the transform is deterministic, keeps two
 * renders of the same graph byte-identical.
 *
 * @param value Coordinate to round.
 * @returns The coordinate with at most two decimal places.
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Options accepted by {@link renderGraphSvg}.
 */
export interface RenderGraphSvgOptions {
  /**
   * Diagram title, written into the document's `<title>` element.
   *
   * Present so an embedded export carries its own accessible name: a `<title>` is what a screen
   * reader announces for an SVG, and what a browser shows as the tooltip of a standalone one.
   * Omitted, the document is titled generically rather than left untitled.
   */
  title?: string;
}

/**
 * Renders a canonical graph as a standalone SVG document.
 *
 * **Icons are deliberately not embedded, and the product name is drawn as text instead.** The
 * vendored glyphs under `../../client/icons/` are real SVG assets and inlining them would work, so
 * this is a choice rather than a limitation, taken for three reasons. Including them means
 * including _all_ of them: the lookup is by `typeId`, so the Worker bundle would carry the whole
 * 140 KB set to draw any one node, against a measured bundle ceiling
 * (`tests/worker/built-bundle.test.ts`) that already exists to catch exactly that kind of growth.
 * They are Cloudflare's own brand marks, and an export handed to an agent is embedded wherever that
 * agent puts it — a README on any host, somebody else's slide deck — which is a materially
 * different distribution posture from rendering them inside Cloudflare's own product UI. And the
 * information a glyph carries here is the product's identity, which the catalogue label states
 * exactly, in text that is legible at any scale, searchable in the document, and readable by a
 * screen reader. The category colour, which is what makes the editor's canvas scannable at a
 * glance, is kept: it is the border, the header tint and the swatch, so a storage node still reads
 * as a storage node. Correctness and legibility beat fidelity.
 *
 * Nothing in the output animates, unlike the canvas's data-flow edges. An SVG embedded in a
 * document is a still picture of an architecture, and a document that started moving when it
 * scrolled into view would be a surprise rather than a feature.
 *
 * @param graph Canonical graph to draw, as `./graph.ts` defines and validates it.
 * @param options Presentation options; see {@link RenderGraphSvgOptions}.
 * @returns A complete, self-contained SVG document. Its `viewBox`, `width` and `height` come from
 *   the nodes' own extents plus a margin, so it scales correctly and nothing is clipped: an empty
 *   graph still produces a valid minimum-sized canvas rather than a degenerate zero-area one, and a
 *   single node or a set of unconnected nodes is framed exactly like a connected graph.
 */
export function renderGraphSvg(graph: GraphData, options: RenderGraphSvgOptions = {}): string {
  const boxes = layoutNodes(graph);

  // Seeded from the first box rather than from `Infinity`, so the empty case is handled by one
  // explicit branch below instead of by arithmetic on infinities that happens to come out right.
  let minX = 0;
  let minY = 0;
  let maxX = NODE_WIDTH;
  let maxY = HEADER_HEIGHT + BODY_LINE;
  let first = true;
  for (const box of boxes.values()) {
    if (first) {
      minX = box.x;
      minY = box.y;
      maxX = box.x + NODE_WIDTH;
      maxY = box.y + box.height;
      first = false;
      continue;
    }
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + NODE_WIDTH);
    maxY = Math.max(maxY, box.y + box.height);
  }

  const originX = round(minX - CANVAS_PADDING);
  const originY = round(minY - CANVAS_PADDING);
  const width = round(maxX - minX + CANVAS_PADDING * 2);
  const height = round(maxY - minY + CANVAS_PADDING * 2);

  const markers = new Map<string, string>();
  const strokes: string[] = [];
  const labels: EdgeLabel[] = [];

  for (const raw of graph.edges as RenderableEdge[]) {
    const source = typeof raw.source === 'string' ? boxes.get(raw.source) : undefined;
    const target = typeof raw.target === 'string' ? boxes.get(raw.target) : undefined;
    // A dangling edge cannot be produced by `./graph-mutations.ts`, which cascades on removal and
    // validates both endpoints on creation, but a graph can also arrive from an older write. It is
    // skipped for the same reason `autoLayout` skips it: a drawing should not fail over an element
    // that has nothing to draw between.
    if (source === undefined || target === undefined) {
      continue;
    }

    const edgeType = text(raw.data?.edgeType);
    const definition = EDGE_TYPE_MAP.get(edgeType);
    const color = definition?.color ?? FALLBACK_EDGE_COLOR;

    let dash = '';
    if (definition?.style === 'dashed') {
      dash = ' stroke-dasharray="8 4"';
    } else if (definition?.style === 'dotted') {
      dash = ' stroke-dasharray="3 3"';
    }

    let marker = '';
    if (definition?.markerEnd === true) {
      // Keyed by colour and named after the catalogue type, so the id is stable across renders and
      // two edge types sharing a colour would still each get a readable id.
      const markerId = `arrow-${edgeType.replace(/[^a-z0-9-]/giu, '')}`;
      markers.set(markerId, renderMarker(markerId, color));
      marker = ` marker-end="url(#${markerId})"`;
    }

    const geometry = routeEdge(source, target);
    strokes.push(
      `<path d="${geometry.path}" fill="none" stroke="${color}" stroke-width="1.5"${dash}`
        + `${marker}/>`
    );

    const label = text(raw.data?.label);
    if (label !== '') {
      labels.push({ value: label, x: geometry.labelX, y: geometry.labelY });
    }
  }

  const nodes = [...boxes.values()].map((box) => renderNode(box)).join('');
  const defs = markers.size === 0 ? '' : `<defs>${[...markers.values()].join('')}</defs>`;
  const title = options.title ?? 'Architecture diagram';

  // A white backdrop in both colour schemes, the same decision the editor's own image export
  // takes: an export is normally pasted into a document or a slide, and a transparent one lands
  // there as unreadable dark text on whatever happens to be behind it.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${originX} ${originY} ${width} ${height}" `
    + `width="${width}" height="${height}" font-family="${FONT_STACK}" role="img">`
    + `<title>${escapeXml(title)}</title>`
    + `<rect x="${originX}" y="${originY}" width="${width}" height="${height}" fill="#ffffff"/>`
    + defs
    + `<g>${strokes.join('')}</g>`
    + `<g>${labels.map((label) => renderEdgeLabel(label)).join('')}</g>`
    + `<g>${nodes}</g>`
    + `</svg>`
  );
}
