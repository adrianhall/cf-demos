import {
  CATEGORY_COLORS,
  NODE_TYPE_MAP,
  type NodeTypeDef,
} from "../../../catalog";
import { ProductIcon } from "../ProductIcon";

/** A single decorative node placed at a fixed pixel position within {@link HeroDiagram}. */
interface HeroNode {
  /** Catalog `typeId` looked up via `NODE_TYPE_MAP` for its real icon, label, and category color. */
  typeId: string;
  /** Pixel offset from the diagram container's left edge. */
  left: number;
  /** Pixel offset from the diagram container's top edge. */
  top: number;
}

/** A straight connector drawn between two {@link HeroNode} centers, identified by array index. */
interface HeroEdge {
  from: number;
  to: number;
}

/** Rendered width/height of every node chip, matching real canvas nodes' `min-width: 10rem`. */
const NODE_WIDTH = 160;
const NODE_HEIGHT_CENTER = 26;

/** Overall diagram canvas size, sized to fit every node in {@link NODES} with margin. */
const DIAGRAM_WIDTH = 560;
const DIAGRAM_HEIGHT = 200;

/**
 * The four nodes shown: a browser client fanning into Workers, which fans out to D1 and KV --
 * the same minimal "compute + storage" shape used throughout `EXPLAIN-DEMO.md` and the
 * blueprint gallery's simplest templates, so a first-time visitor recognizes the pattern the
 * moment they open the real editor.
 */
const NODES: HeroNode[] = [
  { typeId: "client-browser", left: 0, top: 74 },
  { typeId: "worker", left: 200, top: 74 },
  { typeId: "d1", left: 400, top: 6 },
  { typeId: "kv", left: 400, top: 142 },
];

/** Client -> Workers -> {D1, KV}, matching {@link NODES}' indices. */
const EDGES: HeroEdge[] = [
  { from: 0, to: 1 },
  { from: 1, to: 2 },
  { from: 1, to: 3 },
];

/**
 * Look up a {@link HeroNode}'s catalog definition, throwing rather than silently rendering
 * nothing if `typeId` doesn't exist. Unlike `CFNode.tsx`'s equivalent lookup -- which falls back
 * to a generic icon because a real diagram's `typeId` comes from persisted, potentially stale
 * data -- {@link NODES} below is a hardcoded constant in this same file, so an unresolved
 * `typeId` here can only be this file's own authoring mistake (e.g. a typo, or a catalog entry
 * later renamed/removed) and should fail loudly during development instead of quietly rendering
 * an incomplete illustration in production.
 */
export function resolveNodeType(typeId: string): NodeTypeDef {
  const typeDef = NODE_TYPE_MAP.get(typeId);
  if (!typeDef) {
    throw new Error(
      `HeroDiagram references unknown catalog product type "${typeId}".`,
    );
  }
  return typeDef;
}

/** The center point of a node's right or left edge, used as a connector anchor. */
function anchor(
  node: HeroNode,
  side: "left" | "right",
): { x: number; y: number } {
  return {
    x: side === "left" ? node.left : node.left + NODE_WIDTH,
    y: node.top + NODE_HEIGHT_CENTER,
  };
}

/**
 * Purely decorative hero illustration for {@link ../../views/LandingView}, built entirely from
 * this app's own real editor pieces -- `ProductIcon` and the catalog's category colors -- rather
 * than a commissioned image or screenshot. This keeps the visual byte-identical to what a
 * visitor sees the moment they open the editor, and needs no new binary asset or attribution
 * (GitLab issue #4's "identify any images required" is answered by reusing existing, already
 * vendored product icons instead of sourcing new ones).
 *
 * `aria-hidden`: the diagram is illustrative only and communicates nothing that the surrounding
 * headline and CTA copy don't already state in text, so it carries no independent accessible
 * content (matching `ProductIcon`'s own decorative-icon convention). Hidden below a narrow
 * viewport by `.landing__hero-visual` (`../../app.css`) rather than shrunk, so the hero's text
 * and call to action never compete with it for space on a small screen.
 */
export function HeroDiagram() {
  return (
    <div
      className="landing__hero-visual"
      aria-hidden="true"
      style={{
        height: DIAGRAM_HEIGHT,
        position: "relative",
        width: DIAGRAM_WIDTH,
      }}
    >
      <svg
        aria-hidden="true"
        height={DIAGRAM_HEIGHT}
        width={DIAGRAM_WIDTH}
        style={{ inset: 0, position: "absolute" }}
      >
        {EDGES.map((edge) => {
          const from = anchor(NODES[edge.from], "right");
          const to = anchor(NODES[edge.to], "left");
          return (
            <line
              // Static, fixed-length decorative array -- index is a stable key.
              key={`${edge.from}-${edge.to}`}
              className="cf-edge-animated"
              stroke="var(--cf-orange)"
              strokeWidth={2}
              opacity={0.55}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
            />
          );
        })}
      </svg>
      {NODES.map((node) => {
        const typeDef = resolveNodeType(node.typeId);
        const accentColor = CATEGORY_COLORS[typeDef.category];
        return (
          <div
            key={node.typeId}
            className="cf-node"
            style={{
              borderColor: accentColor,
              left: node.left,
              position: "absolute",
              top: node.top,
              width: NODE_WIDTH,
            }}
          >
            <div
              className="cf-node__header"
              style={{ backgroundColor: `${accentColor}14` }}
            >
              <ProductIcon
                icon={typeDef.icon}
                className="cf-node__icon"
                size={24}
                color={accentColor}
              />
              <span className="cf-node__label">{typeDef.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
