import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { HeroDiagram, resolveNodeType } from '../../src/client/components/landing/HeroDiagram.tsx';

/**
 * @file Covers the decorative hero illustration. Two properties matter: it is built from the real
 *   catalogue rather than hard-coded labels, so it cannot drift from what the editor renders; and
 *   nothing inside it is reachable by a keyboard, because it lives under `aria-hidden` and a
 *   focusable element there would be a tab stop with no accessible name.
 */

describe('resolveNodeType', () => {
  it('resolves a catalogue product to its real definition', () => {
    expect(resolveNodeType('worker')).toMatchObject({ category: 'compute', label: 'Workers' });
  });

  // Deliberately the opposite of `ProductIcon`'s silent fallback. That component's `typeId` comes
  // from persisted, potentially stale diagram data; this one's comes from a hard-coded constant in
  // the same file, so an unresolved value can only be an authoring mistake and should fail loudly
  // rather than shipping an illustration with a node missing.
  it('throws for a product the catalogue does not define, naming the value', () => {
    expect(() => resolveNodeType('not-a-product')).toThrow(/not-a-product/u);
  });
});

describe('HeroDiagram', () => {
  it('renders every node from the catalogue', () => {
    const { container } = render(<HeroDiagram />);

    expect(container.querySelectorAll('.cf-node')).toHaveLength(4);
  });

  // Labels come from the catalogue, not from this component, so the illustration shows the same
  // product names the editor's own palette and canvas do.
  it.each(['Client (Browser)', 'Workers', 'D1 Database', 'Workers KV'])(
    'labels a node with the catalogue label %s',
    (label) => {
      const { container } = render(<HeroDiagram />);

      const labels = [...container.querySelectorAll('.cf-node__label')].map(
        (node) => node.textContent
      );

      expect(labels).toContain(label);
    }
  );

  // Scoped to the connector layer's own class rather than every `line` in the subtree: the inlined
  // product icons are real SVGs and contain lines of their own, so an unscoped query counts those
  // too and would pass or fail on which icons happen to be in the illustration.
  it('connects the nodes with one line per edge', () => {
    const { container } = render(<HeroDiagram />);

    expect(container.querySelectorAll('line.cf-edge-animated')).toHaveLength(3);
  });

  it('uses the real category colour for each node border', () => {
    const { container } = render(<HeroDiagram />);

    for (const node of container.querySelectorAll<HTMLElement>('.cf-node')) {
      expect(node.style.borderColor).not.toBe('');
    }
  });

  describe('accessibility', () => {
    it('hides itself from assistive technology', () => {
      const { container } = render(<HeroDiagram />);

      expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    });

    it('hides its connector layer too', () => {
      const { container } = render(<HeroDiagram />);

      expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    });

    // Nothing focusable may live under `aria-hidden`: a keyboard user would land on a tab stop that
    // assistive technology cannot describe at all.
    it('contains no focusable element', () => {
      const { container } = render(<HeroDiagram />);

      expect(
        container.querySelectorAll('a, button, input, select, textarea, [tabindex]')
      ).toHaveLength(0);
    });

    it('keeps every product icon decorative', () => {
      const { container } = render(<HeroDiagram />);

      const icons = container.querySelectorAll('.cf-node__icon');

      expect(icons.length).toBeGreaterThan(0);
      for (const icon of icons) {
        expect(icon).toHaveAttribute('aria-hidden', 'true');
      }
    });
  });
});
