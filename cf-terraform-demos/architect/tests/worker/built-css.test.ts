import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * @file Built-stylesheet fidelity contract, run in the Node-based `worker` Vitest project. This is
 *   the one test in the suite that reads build output rather than source, and that is the entire
 *   point of it. Two different kinds of regression are invisible to every other project here:
 *
 *   1. **Re-authoring drift.** jsdom applies no stylesheets and has no font metrics, so a DOM test
 *      passes just as happily against 700 lines of approximated CSS as against the 2,023 lines this
 *      demo actually ports. Nothing but an assertion on the stylesheet's own content can fail on a
 *      brand hex typed from memory or a font stack swapped for a face the demo never loads.
 *   2. **Build-only transformation.** Vite's CSS minifier lowers `light-dark()` into a
 *      `prefers-color-scheme` polyfill by default, which reads the OS preference directly and
 *      ignores the `color-scheme` property the in-app theme control sets. The result works
 *      perfectly in `vite dev` and silently breaks the theme override in production. Asserting
 *      against the **source** file would therefore pass in exactly the case that matters; see
 *      `vite.config.ts`'s `Features.LightDark` exclusion.
 */

/**
 * Directory the Cloudflare Vite plugin emits built client assets into.
 */
const ASSET_DIR = path.resolve(
  import.meta.dirname,
  '../../.cloudflare/output/v0/workers/default/assets/assets'
);

/**
 * Brand orange. Asserted as a literal because the value a re-authoring would plausibly produce —
 * `#f48120` — is a transposition of this one, close enough to pass a glance and wrong everywhere.
 */
const BRAND_ORANGE = '#f6821f';

/**
 * The source font stack, in full. The demo loads no web font, so every face here must be one the
 * platform already has; a stack naming a face the demo never loads silently renders as the browser
 * default.
 */
const FONT_STACK_FACES = ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'];

/**
 * Every design token the ported stylesheet defines. A missing token is the signature of a partially
 * copied stylesheet, which is the specific failure this contract exists to catch.
 */
const REQUIRED_TOKENS = [
  '--cf-border',
  '--cf-danger',
  '--cf-danger-solid',
  '--cf-field-border',
  '--cf-orange',
  '--cf-orange-dark',
  '--cf-surface',
  '--cf-surface-alt'
];

/**
 * Reads the single built stylesheet.
 *
 * @returns The stylesheet's contents.
 * @throws {Error} When no build output is present, naming the command that produces it, or when the
 *   build emitted a number of stylesheets other than one — in which case this test is asserting
 *   against an arbitrary file and must be updated rather than quietly trusted.
 */
async function readBuiltStylesheet(): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(ASSET_DIR);
  } catch {
    throw new Error(
      `No build output at ${ASSET_DIR}. Run \`pnpm build\` first, or run \`pnpm check\`, which `
        + 'builds before asserting this contract.'
    );
  }

  const stylesheets = entries.filter((entry) => entry.endsWith('.css'));
  if (stylesheets.length !== 1) {
    throw new Error(
      `Expected exactly one built stylesheet, found ${stylesheets.length}: `
        + `${stylesheets.join(', ') || '(none)'}. Update this contract to match the new output.`
    );
  }

  return readFile(path.join(ASSET_DIR, stylesheets[0] as string), 'utf8');
}

describe('built stylesheet contract', () => {
  let css = '';

  beforeAll(async () => {
    css = await readBuiltStylesheet();
  });

  it('keeps light-dark() as native CSS rather than a prefers-color-scheme polyfill', () => {
    // The polyfill form reads the OS preference and ignores the `color-scheme` property that
    // `src/client/lib/theme.ts` sets, so the in-app theme override stops affecting any
    // `light-dark()` background or border while unset `color` properties keep working.
    expect(css).toContain('light-dark(');
    expect(css).not.toContain('prefers-color-scheme');
  });

  it('declares the root color-scheme that drives every light-dark() value', () => {
    expect(css).toMatch(/color-scheme:\s*light dark/u);
  });

  it('uses the brand orange', () => {
    expect(css.toLowerCase()).toContain(BRAND_ORANGE);
  });

  it.each(FONT_STACK_FACES)('keeps %s in the font stack', (face) => {
    expect(css).toContain(face);
  });

  it.each(REQUIRED_TOKENS)('defines the %s design token', (token) => {
    expect(css).toContain(`${token}:`);
  });

  // A blunt instrument on purpose. The precise figure is not meaningful; what is meaningful is
  // that a stylesheet re-authored from scratch came out at roughly a third of the ported one's
  // size, and that difference was the gallery cards, the modal layout, the toolbar and the
  // responsive breakpoints rather than dead weight. Minification roughly halves the source, so
  // this floor sits well below a faithful build and well above a re-authored one.
  it('is substantial enough not to be a re-authored subset', () => {
    expect(css.length).toBeGreaterThan(18_000);
  });

  it('keeps the responsive breakpoints', () => {
    expect(css).toContain('@media');
  });

  it('keeps the print rules', () => {
    expect(css).toContain('print');
  });

  describe('the in-app theme override', () => {
    // The appearance control works by setting `color-scheme` on `<html>`, so every themed value has
    // to be one `color-scheme` actually drives. A build that lowered these into a
    // `prefers-color-scheme` polyfill would leave the control changing icons — which follow the
    // browser's native handling — while backgrounds and borders stayed stuck in one scheme. That is
    // invisible in `vite dev`, which passes `light-dark()` through untouched, so it can only be
    // caught here.
    it.each(['--cf-surface', '--cf-surface-alt', '--cf-border', '--cf-field-border'])(
      'drives the %s token with a native light-dark() value',
      (token) => {
        const declaration = new RegExp(String.raw`${token}:\s*light-dark\(`, 'u');

        expect(css).toMatch(declaration);
      }
    );

    // The control clears the inline property to return to the system preference, which only falls
    // back to following the OS if the stylesheet itself declares `light dark` at the root.
    it('declares the root color-scheme the control clears back to', () => {
      expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light dark/u);
    });

    // Every `<button>` opts out of native chrome. Without it, a browser paints a button's
    // background using the *system's* appearance rather than this page's `color-scheme`, so an
    // explicitly chosen scheme leaves icon-only controls showing the other scheme's background —
    // a dark background behind a dark icon after choosing light mode.
    it('opts buttons out of native chrome so the override reaches them', () => {
      expect(css).toMatch(/button\s*\{[^}]*appearance:\s*none/u);
    });

    // The non-underlined treatment every chrome link depends on. The stylesheet has no global `a`
    // rule, so losing this class returns the banner's links to underlined, link-coloured body text.
    it('keeps the shared chrome-link opt-out', () => {
      expect(css).toMatch(/\.nav-link\s*\{[^}]*text-decoration:\s*none/u);
    });
  });
});
