import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ProductIcon } from '../../src/client/components/ProductIcon.tsx';

/**
 * @file Covers the one component that renders both icon kinds. The behaviour that matters is the
 *   graceful degradation: a node's `typeId` arrives from persisted diagram data, so an icon this
 *   build has no source for must leave a label-only node rather than failing the canvas around it.
 */

describe('ProductIcon', () => {
  describe('vendored Cloudflare icons', () => {
    it('inlines the official SVG so it can be recoloured and exported', () => {
      const { container } = render(<ProductIcon icon={{ kind: 'svg', name: 'workers' }} />);

      expect(container.querySelector('.product-icon--svg svg')).not.toBeNull();
    });

    it('applies the requested colour and size', () => {
      const { container } = render(
        <ProductIcon icon={{ kind: 'svg', name: 'workers' }} size={32} color="#f6821f" />
      );

      const wrapper = container.querySelector<HTMLElement>('.product-icon--svg');

      expect(wrapper?.style.height).toBe('32px');
      expect(wrapper?.style.width).toBe('32px');
      expect(wrapper?.style.color).toBe('rgb(246, 130, 31)');
    });

    it('merges a caller-supplied class with its own', () => {
      const { container } = render(
        <ProductIcon icon={{ kind: 'svg', name: 'workers' }} className="cf-node__icon" />
      );

      const wrapper = container.querySelector('.product-icon--svg');

      expect(wrapper).toHaveClass('product-icon--svg');
      expect(wrapper).toHaveClass('cf-node__icon');
    });

    // Degrades rather than throwing. The `typeId` behind this comes from persisted, potentially
    // stale diagram data, so a renamed or removed icon must cost one glyph, not the whole canvas.
    it('renders nothing for an icon this build has no file for', () => {
      const { container } = render(<ProductIcon icon={{ kind: 'svg', name: 'not-a-product' }} />);

      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('generic feather icons', () => {
    it.each(['Monitor', 'Smartphone', 'Globe', 'Database', 'Clock'])(
      'renders the %s icon used by the generic node types',
      (name) => {
        const { container } = render(<ProductIcon icon={{ kind: 'feather', name }} />);

        expect(container.querySelector('svg')).not.toBeNull();
      }
    );

    it('applies the requested size', () => {
      const { container } = render(
        <ProductIcon icon={{ kind: 'feather', name: 'Monitor' }} size={40} />
      );

      expect(container.querySelector('svg')).toHaveAttribute('width', '40');
    });

    // The map is deliberately a small hand-maintained set rather than a namespace import, which
    // would pull all ~280 of the library's icons into the bundle. An unlisted name degrades here,
    // and the catalogue's own test is what stops one being referenced in the first place.
    it('renders nothing for an icon outside the maintained set', () => {
      const { container } = render(<ProductIcon icon={{ kind: 'feather', name: 'Anchor' }} />);

      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('accessibility', () => {
    // Every call site already has an adjacent visible or accessible label — the node's own label, a
    // palette item's `aria-label` — so an icon that announced itself would make a screen reader
    // read every product name twice.
    it.each([
      ['svg', { kind: 'svg', name: 'workers' } as const],
      ['feather', { kind: 'feather', name: 'Monitor' } as const]
    ])('keeps the %s icon decorative', (_kind, icon) => {
      const { container } = render(<ProductIcon icon={icon} />);

      expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    });

    it('renders no focusable element', () => {
      const { container } = render(<ProductIcon icon={{ kind: 'svg', name: 'workers' }} />);

      expect(container.querySelectorAll('a, button, [tabindex]')).toHaveLength(0);
    });
  });

  it('defaults to a 24-pixel icon', () => {
    const { container } = render(<ProductIcon icon={{ kind: 'feather', name: 'Monitor' }} />);

    expect(container.querySelector('svg')).toHaveAttribute('width', '24');
  });

  // The vendored icons are byte-identical copies of Cloudflare's own artwork, and a few of them
  // paint their shapes with a literal `fill="#000"` rather than inheriting. A presentation
  // attribute on the shape beats the `fill: currentColor` set on the root `<svg>`, so those icons
  // would render solid black: invisible on a dark-theme node and ignoring the category colour
  // everywhere. `app.css` therefore carries a second rule targeting the shapes themselves. jsdom
  // does not apply stylesheets, so these cases assert the *selector contract* the rule depends on
  // — which shapes it must reach and which it must leave alone — while `built-css.test.ts` proves
  // the rule survives into the built stylesheet.
  describe('theme-aware fills', () => {
    it.each(['ai-search', 'dynamic-workers'])(
      'exposes paintable shapes in %s for the fill override to reach',
      (name) => {
        const { container } = render(<ProductIcon icon={{ kind: 'svg', name }} />);

        const painted = container.querySelectorAll('svg [fill]:not([fill="none"])');

        expect(painted.length).toBeGreaterThan(0);
      }
    );

    // The counter-case, and the reason the selector excludes `fill="none"`: this icon is a line
    // drawing whose shapes are deliberately unpainted and outlined with `stroke`. Forcing a fill
    // onto them would turn it into a solid blob, so the override must select nothing here.
    it('leaves the outline-drawn artifacts icon unfilled', () => {
      const { container } = render(<ProductIcon icon={{ kind: 'svg', name: 'artifacts' }} />);

      expect(container.querySelectorAll('svg [fill]:not([fill="none"])')).toHaveLength(0);
      expect(container.querySelectorAll('svg [stroke="currentColor"]').length).toBeGreaterThan(0);
    });
  });
});
