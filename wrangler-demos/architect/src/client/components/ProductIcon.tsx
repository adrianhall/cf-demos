import {
  Clock,
  Database,
  Globe,
  type Icon,
  Monitor,
  Smartphone,
} from "react-feather";
import type { ProductIcon as ProductIconDef } from "../../catalog";

/**
 * Every `react-feather` icon a catalog entry can reference by name (`../../catalog.ts`'s
 * `featherIcon()`). A named import per icon, not `import * as FeatherIcons from "react-feather"`
 * -- a namespace import defeats tree-shaking for a dynamic `FeatherIcons[name]` lookup, since the
 * bundler can no longer tell which of the library's ~280 icons are actually reachable and must
 * include all of them. Keep this map in sync with every `featherIcon(...)` call in the catalog.
 */
const FEATHER_ICONS: Record<string, Icon> = {
  Clock,
  Database,
  Globe,
  Monitor,
  Smartphone,
};

/**
 * Raw text content of every vendored icon under `../icons/*.svg`, keyed by its resolved import
 * path, loaded eagerly at build time. These are byte-identical copies of Cloudflare's own
 * `cloudflare-docs` repository icon set (Issue 7, docs/09-ARCHITECT.md Phase 7) -- monochrome
 * SVGs with no `fill`/`stroke` attribute of their own (SVG's implicit default is opaque black),
 * so `.product-icon--svg svg` (`../app.css`) forces `fill: currentColor` to make them
 * theme-aware and recolorable, the same way `react-feather`'s icons already are via `stroke`.
 */
const svgSources = import.meta.glob("../icons/*.svg", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

/** Look up a vendored icon's raw SVG markup by its catalog `name` (`../icons/<name>.svg`). */
function svgSource(name: string): string | undefined {
  return svgSources[`../icons/${name}.svg`];
}

/**
 * Renders a catalog {@link ProductIconDef}: either a vendored official Cloudflare product SVG
 * (`kind: "svg"`, inlined via `dangerouslySetInnerHTML` so it can be recolored with CSS and
 * survives `ExportButton.tsx`'s `html-to-image` PNG/SVG capture -- a CSS `mask-image` approach
 * does not, see docs/DECISIONS.md) or a `react-feather` icon (`kind: "feather"`, the four
 * "External / Generic" category node types, which have no official Cloudflare icon). Used by
 * `editor/nodes/CFNode.tsx` and `editor/panels/ServicePalette.tsx` so both render every catalog
 * icon identically.
 *
 * Always decorative (`aria-hidden`): every call site already has an adjacent visible/accessible
 * text label (the node's own label, or the palette item's `aria-label`), so the icon itself
 * carries no independent accessible content.
 *
 * @param icon Catalog icon definition (`../../catalog.ts`'s `NodeTypeDef.icon`).
 * @param size Rendered width/height in pixels.
 * @param color CSS color the icon renders in, via `currentColor` (both vendored SVGs, forced by
 * `../app.css`, and `react-feather`'s own default `stroke="currentColor"`). Typically the
 * node's category or accent color, matching the border/handle treatment in `CFNode.tsx`.
 * @param className Additional class name(s) applied to the icon's root element.
 */
export function ProductIcon({
  icon,
  size = 24,
  color,
  className,
}: {
  icon: ProductIconDef;
  size?: number;
  color?: string;
  className?: string;
}) {
  if (icon.kind === "feather") {
    const FeatherIcon = FEATHER_ICONS[icon.name];
    if (!FeatherIcon) return null;
    return (
      <FeatherIcon
        className={className}
        size={size}
        color={color}
        aria-hidden="true"
      />
    );
  }

  const source = svgSource(icon.name);
  if (!source) return null;

  // `source` is one of this project's own vendored, build-time-only SVG assets under
  // `../icons/` (byte-identical copies of official Cloudflare product icons), resolved entirely
  // from the static `import.meta.glob` map above -- never from user input, catalog data, or any
  // runtime/network value.
  return (
    <span
      className={`product-icon--svg${className ? ` ${className}` : ""}`}
      style={{ color, display: "inline-flex", height: size, width: size }}
      aria-hidden="true"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: see the comment above this element.
      dangerouslySetInnerHTML={{ __html: source }}
    />
  );
}
