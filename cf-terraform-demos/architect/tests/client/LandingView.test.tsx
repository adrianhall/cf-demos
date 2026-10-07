import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LandingView } from '../../src/client/views/LandingView.tsx';

/**
 * @file Covers the public landing page's structure. jsdom applies no stylesheets, so nothing here
 *   can observe a visual regression — the built-stylesheet contract and a real-browser review own
 *   that. What these tests do own is the page's heading hierarchy, its named landmarks and the fact
 *   that every route into the gated subtree is a real anchor rather than a scripted navigation.
 */

/**
 * Renders the page with an anonymous visitor.
 */
function renderLanding(): void {
  render(<LandingView />);
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 401 }))
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn()
    }))
  );
  localStorage.clear();
});

describe('LandingView', () => {
  it('renders the shared banner', () => {
    renderLanding();

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Architect' })).toBeInTheDocument();
  });

  describe('heading hierarchy', () => {
    // Exactly one `h1`. More than one leaves a screen-reader user with no single answer to "what
    // is this page?", and none leaves the document with no accessible name at all.
    it('has exactly one level-one heading', () => {
      renderLanding();

      const headings = screen.getAllByRole('heading', { level: 1 });

      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent(/design your cloudflare architecture/iu);
    });

    it('titles every section at level two', () => {
      renderLanding();

      const titles = screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent);

      expect(titles).toEqual([
        'Why teams diagram here',
        'Everything you need to document a stack',
        'Built for how you already work',
        'Ready to see your architecture on a canvas?'
      ]);
    });

    // Cards sit inside sections, so their headings must be one level deeper. A card promoted to
    // `h2` would read as a peer of the section containing it.
    it('puts every card heading one level below its section', () => {
      renderLanding();

      expect(screen.getAllByRole('heading', { level: 3 }).length).toBe(13);
    });
  });

  describe('named landmarks', () => {
    // A section is only a landmark if it has an accessible name, which is what `aria-labelledby`
    // pointing at its own heading provides. Without it the region is anonymous and a screen reader
    // cannot offer it for navigation.
    it.each([
      'Why teams diagram here',
      'Everything you need to document a stack',
      'Built for how you already work',
      'Ready to see your architecture on a canvas?'
    ])('names the %s region after its own heading', (name) => {
      renderLanding();

      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    });
  });

  describe('the Access boundary', () => {
    // Both the hero and the closing banner offer the same pair, and both must be real anchors: a
    // button with a handler would resolve the path inside an already-loaded bundle, past the point
    // at which Cloudflare Access can intercept the document request.
    it('offers the primary call to action twice, each a real anchor into /app', () => {
      renderLanding();

      const links = screen.getAllByRole('link', { name: 'Open the editor' });

      expect(links).toHaveLength(2);
      for (const link of links) {
        expect(link.tagName).toBe('A');
        expect(link).toHaveAttribute('href', '/app');
      }
    });

    it('offers the blueprint gallery twice, each a real anchor', () => {
      renderLanding();

      const links = screen.getAllByRole('link', { name: 'Browse blueprints' });

      expect(links).toHaveLength(2);
      for (const link of links) {
        expect(link).toHaveAttribute('href', '/blueprints');
      }
    });

    it('styles the hero call to action as the primary action', () => {
      renderLanding();

      expect(screen.getAllByRole('link', { name: 'Open the editor' })[0]).toHaveClass(
        'button--primary'
      );
    });
  });

  describe('card content', () => {
    it.each([
      ['Why teams diagram here', 3],
      ['Everything you need to document a stack', 6],
      ['Built for how you already work', 4]
    ])('renders %i cards in the %s section', (name, count) => {
      renderLanding();

      const region = screen.getByRole('region', { name: name as string });

      expect(within(region).getAllByRole('heading', { level: 3 })).toHaveLength(count as number);
    });

    it('gives every card body copy, not just a title', () => {
      renderLanding();

      for (const heading of screen.getAllByRole('heading', { level: 3 })) {
        const card = heading.closest('article');

        expect(card).not.toBeNull();
        expect(card?.querySelector('.landing__card-body')?.textContent ?? '').not.toBe('');
      }
    });

    // The card icons restate nothing the title and body do not already say, so announcing them
    // would make a screen reader read decoration between every heading.
    it('keeps every card icon decorative', () => {
      const { container } = render(<LandingView />);

      const icons = container.querySelectorAll('.landing__card-icon');

      expect(icons.length).toBeGreaterThan(0);
      for (const icon of icons) {
        expect(icon).toHaveAttribute('aria-hidden', 'true');
      }
    });
  });

  describe('the hero illustration', () => {
    // Decorative: it communicates nothing the headline and call-to-action copy do not already state
    // in text, and nothing inside it is focusable, so it is hidden from assistive technology
    // entirely rather than given a description that would repeat the hero.
    it('hides the illustration from assistive technology', () => {
      const { container } = render(<LandingView />);

      expect(container.querySelector('.landing__hero-visual')).toHaveAttribute(
        'aria-hidden',
        'true'
      );
    });

    it('places no focusable element inside the hidden illustration', () => {
      const { container } = render(<LandingView />);

      const visual = container.querySelector('.landing__hero-visual');

      expect(visual?.querySelectorAll('a, button, input, [tabindex]')).toHaveLength(0);
    });
  });
});
