import { Clock, Database, Globe, type Icon, Monitor, Smartphone } from 'react-feather';
import type { ProductIcon as ProductIconDef } from '../../catalog.ts';

/**
 * Every `react-feather` icon a catalogue entry can reference by name (`../../catalog.ts`'s
 * `featherIcon()`).
 *
 * A named import per icon, not `import * as FeatherIcons from 'react-feather'` — a namespace import
 * defeats tree-shaking for a dynamic `FeatherIcons[name]` lookup, since the bundler can no longer
 * tell which of the library's ~280 icons are reachable and must include all of them. Keep this map
 * in sync with every `featherIcon(...)` call in the catalogue; the catalogue's own test asserts
 * every `feather`-kind name resolves to a real export, so an unlisted one fails there.
 */
const FEATHER_ICONS: Record<string, Icon> = {
  Clock,
  Database,
  Globe,
  Monitor,
  Smartphone
};

/**
 * Raw text content of every vendored icon under `../icons/*.svg`, keyed by its resolved import path
 * and loaded eagerly at build time.
 *
 * These are byte-identical copies of Cloudflare's own official product icon set — monochrome SVGs
 * with no `fill`/`stroke` attribute of their own, since SVG's implicit default is opaque black — so
 * `.product-icon--svg svg` in `../app.css` forces `fill: currentColor` to make them theme-aware and
 * recolourable, the same way `react-feather`'s icons already are via `stroke`.
 */
const svgSources = import.meta.glob('../icons/*.svg', {
  eager: true,
  import: 'default',
  query: '?raw'
}) as Record<string, string>;

/**
 * Looks up a vendored icon's raw SVG markup.
 *
 * @param name Catalogue icon name, resolved as `../icons/<name>.svg`.
 * @returns The icon's markup, or `undefined` when no such file was vendored.
 */
function svgSource(name: string): string | undefined {
  return svgSources[`../icons/${name}.svg`];
}

/**
 * Props for {@link ProductIcon}.
 */
export interface ProductIconProps {
  /**
   * Catalogue icon definition, from `../../catalog.ts`'s `NodeTypeDef.icon`.
   */
  icon: ProductIconDef;
  /**
   * Rendered width and height in pixels.
   */
  size?: number;
  /**
   * CSS colour the icon renders in, via `currentColor` — both for vendored SVGs, forced by
   * `../app.css`, and for `react-feather`'s own default `stroke="currentColor"`. Typically the
   * node's category colour, matching its border and handle treatment.
   */
  color?: string;
  /**
   * Additional class name(s) applied to the icon's root element.
   */
  className?: string;
}

/**
 * Renders a catalogue icon: either a vendored official Cloudflare product SVG (`kind: 'svg'`,
 * inlined so it can be recoloured with CSS and survives the export feature's `html-to-image`
 * capture) or a `react-feather` icon (`kind: 'feather'`, used by the "External / Generic" node
 * types and `cron-trigger`, none of which have an official Cloudflare glyph).
 *
 * Always decorative (`aria-hidden`): every call site already has an adjacent visible or accessible
 * text label — the node's own label, or a palette item's `aria-label` — so the icon carries no
 * independent accessible content. An icon that announced itself as well would make a screen reader
 * read every product name twice.
 *
 * @param props Icon definition and presentation; see {@link ProductIconProps}.
 * @returns The rendered icon, or `null` when the definition names an icon this build has no source
 *   for. Returning `null` rather than throwing is deliberate here, unlike in the hero diagram's own
 *   lookup: a node's `typeId` comes from persisted, potentially stale diagram data, so an
 *   unresolvable icon must degrade to a label-only node rather than failing the whole canvas.
 */
export function ProductIcon({ icon, size = 24, color, className }: ProductIconProps) {
  if (icon.kind === 'feather') {
    const FeatherIcon = FEATHER_ICONS[icon.name];
    if (!FeatherIcon) {
      return null;
    }
    return <FeatherIcon className={className} size={size} color={color} aria-hidden="true" />;
  }

  const source = svgSource(icon.name);
  if (!source) {
    return null;
  }

  return (
    <span
      className={`product-icon--svg${className ? ` ${className}` : ''}`}
      style={{ color, display: 'inline-flex', height: size, width: size }}
      aria-hidden="true"
      // Not user input. `source` is one of this project's own vendored, build-time-only assets under
      // `../icons/`, resolved entirely from the static `import.meta.glob` map above — never from
      // catalogue data, a network response, or any runtime value. Inlining is what lets the icon be
      // recoloured through `currentColor` and captured by the export feature.
      dangerouslySetInnerHTML={{ __html: source }}
    />
  );
}
