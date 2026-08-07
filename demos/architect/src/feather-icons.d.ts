/**
 * `feather-icons` ships no type declarations. This ambient module declares only the surface this
 * demo actually uses (`FeatherIcon.vue`) — the raw SVG-string renderer, not the DOM-mutating
 * `feather.replace()` API this demo never calls.
 */
declare module "feather-icons" {
  /** One curated Feather icon's renderer. */
  interface FeatherIconDefinition {
    /**
     * Render this icon as an SVG markup string.
     *
     * @param attrs Optional SVG attribute overrides (`width`, `height`, `class`, etc.).
     * @returns Complete `<svg>` markup.
     */
    toSvg(attrs?: Record<string, string | number>): string;
  }

  /** Every bundled Feather icon, keyed by its published name (`"search"`, `"trash-2"`, etc). */
  const icons: Record<string, FeatherIconDefinition>;
  export { icons };
}
