import { CATEGORY_COLORS, NODE_TYPE_MAP, type NodeTypeDef } from '../../../catalog.ts';
import { ProductIcon } from '../ProductIcon.tsx';

/**
 * A single decorative node placed at a fixed pixel position within {@link HeroDiagram}.
 */
interface HeroNode {
  /**
   * Catalogue `typeId`, looked up through `NODE_TYPE_MAP` for its real icon, label and category
   * colour.
   */
  typeId: string;
  /**
   * Pixel offset from the diagram container's left edge.
   */
  left: number;
  /**
   * Pixel offset from the diagram container's top edge.
   */
  top: number;
}

/**
 * A straight connector drawn between two {@link HeroNode} centres, each identified by array index.
 */
interface HeroEdge {
  /**
   * Index in {@link NODES} of the node the connector leaves.
   */
  from: number;
  /**
   * Index in {@link NODES} of the node the connector enters.
   */
  to: number;
}

/**
 * Rendered width of every node chip, matching a real canvas node's `min-width: 10rem`.
 */
const NODE_WIDTH = 160;

/**
 * Vertical offset from a node's top edge to its connector anchor.
 */
const NODE_HEIGHT_CENTER = 26;

/**
 * Overall diagram canvas width, sized to fit every node in {@link NODES} with margin.
 */
const DIAGRAM_WIDTH = 560;

/**
 * Overall diagram canvas height.
 */
const DIAGRAM_HEIGHT = 200;

/**
 * The four nodes shown: a browser client fanning into Workers, which fans out to D1 and KV.
 *
 * Deliberately the same minimal "compute plus storage" shape as the simplest blueprint templates,
 * so a first-time visitor recognises the pattern the moment they open the real editor.
 */
const NODES: HeroNode[] = [
  { typeId: 'client-browser', left: 0, top: 74 },
  { typeId: 'worker', left: 200, top: 74 },
  { typeId: 'd1', left: 400, top: 6 },
  { typeId: 'kv', left: 400, top: 142 }
];

/**
 * Client → Workers → {D1, KV}, matching {@link NODES}' indices.
 */
const EDGES: HeroEdge[] = [
  { from: 0, to: 1 },
  { from: 1, to: 2 },
  { from: 1, to: 3 }
];

/**
 * Looks up a {@link HeroNode}'s catalogue definition.
 *
 * Throws rather than rendering nothing, which is the opposite of `ProductIcon`'s fallback and
 * deliberately so: that component's `typeId` arrives from persisted, potentially stale diagram
 * data, whereas {@link NODES} is a hard-coded constant in this same file. An unresolved `typeId`
 * here can therefore only be this file's own authoring mistake — a typo, or a catalogue entry later
 * renamed — and should fail loudly in development rather than quietly shipping an incomplete
 * illustration.
 *
 * @param typeId Catalogue product type to resolve.
 * @returns The catalogue definition.
 * @throws {Error} When `typeId` is not in the catalogue, naming the offending value.
 */
export function resolveNodeType(typeId: string): NodeTypeDef {
  const typeDef = NODE_TYPE_MAP.get(typeId);
  if (!typeDef) {
    throw new Error(`HeroDiagram references unknown catalogue product type "${typeId}".`);
  }
  return typeDef;
}

/**
 * Computes the centre point of a node's left or right edge, used as a connector anchor.
 *
 * @param node Node to anchor against.
 * @param side Edge to anchor on.
 * @returns The anchor's coordinates within the diagram container.
 */
function anchor(node: HeroNode, side: 'left' | 'right'): { x: number; y: number } {
  return {
    x: side === 'left' ? node.left : node.left + NODE_WIDTH,
    y: node.top + NODE_HEIGHT_CENTER
  };
}

/**
 * Purely decorative hero illustration for the landing page, built entirely from this application's
 * own real editor pieces — `ProductIcon` and the catalogue's category colours — rather than a
 * screenshot or a commissioned image. That keeps the illustration identical to what a visitor sees
 * the moment they open the editor, and needs no new binary asset or attribution.
 *
 * `aria-hidden`, because the diagram communicates nothing the surrounding headline and
 * call-to-action copy does not already state in text, so it carries no independent accessible
 * content. It is hidden entirely below a narrow viewport by `.landing__hero-visual` rather than
 * shrunk, so the hero's text and primary action never compete with it for space on a small screen.
 *
 * @returns The hero illustration.
 */
export function HeroDiagram() {
  return (
    <div
      className="landing__hero-visual"
      aria-hidden="true"
      style={{
        height: DIAGRAM_HEIGHT,
        position: 'relative',
        width: DIAGRAM_WIDTH
      }}
    >
      <svg
        aria-hidden="true"
        height={DIAGRAM_HEIGHT}
        width={DIAGRAM_WIDTH}
        style={{ inset: 0, position: 'absolute' }}
      >
        {EDGES.map((edge) => {
          const from = anchor(NODES[edge.from] as HeroNode, 'right');
          const to = anchor(NODES[edge.to] as HeroNode, 'left');
          return (
            <line
              // A static, fixed-length decorative array, so the index pair is a stable key.
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
              position: 'absolute',
              top: node.top,
              width: NODE_WIDTH
            }}
          >
            <div className="cf-node__header" style={{ backgroundColor: `${accentColor}14` }}>
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
