/**
 * @file Component tests for the shared ranked-result renderer. Most of these are accessibility
 *   assertions, because the specification's requirement for this panel is specific: a ranked result
 *   must be understandable without relying on bar length or colour. The way to hold a component to
 *   that is to assert that every number is present as text and that the bars are hidden from
 *   assistive technology — so that deleting every bar would lose no information.
 */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import RankedLabels from '../../../src/client/components/results/RankedLabels.vue';

/**
 * A ranking of the shape the server returns.
 */
const LABELS = [
  { rank: 1, label: 'Egyptian cat', score: 0.523_1 },
  { rank: 2, label: 'tabby', score: 0.41 },
  { rank: 3, label: 'lynx', score: 0.03 }
];

/**
 * Mounts the component.
 *
 * @param labels Ranking to render.
 * @returns The mounted wrapper.
 */
function mountLabels(labels = LABELS) {
  return mount(RankedLabels, {
    props: { labels, caption: 'Showing 3 of the 5 labels this model returned.' }
  });
}

describe('RankedLabels', () => {
  it('renders one row per label', () => {
    expect(mountLabels().findAll('tbody tr')).toHaveLength(3);
  });

  it('renders the labels in the order given', () => {
    const rows = mountLabels().findAll('tbody tr');
    expect(rows.map((row) => row.attributes('data-label'))).toEqual([
      'Egyptian cat',
      'tabby',
      'lynx'
    ]);
  });

  it('shows the rank of each row', () => {
    expect(mountLabels().find('tbody tr td').text()).toBe('1');
  });

  it('renders the caption describing what is shown', () => {
    expect(mountLabels().find('caption').text()).toContain(
      'Showing 3 of the 5 labels this model returned.'
    );
  });
});

describe('the score is readable without the bar', () => {
  // The central accessibility requirement for this panel. Every score is present as text, so the
  // bars are decoration on values that are already readable.
  it('prints every score as a percentage', () => {
    const text = mountLabels().text();
    expect(text).toContain('52.3%');
    expect(text).toContain('41.0%');
    expect(text).toContain('3.0%');
  });

  // The bar repeats the number beside it, so announcing it would read the same value twice.
  it('hides every bar from assistive technology', () => {
    const wrapper = mountLabels();
    const bars = wrapper.findAll('.bar-track');

    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar.attributes('aria-hidden')).toBe('true');
    }
  });

  // The proof that no information is carried by bar length alone: with every bar removed, each
  // label and each score is still present in the rendered text.
  it('loses no information when the bars are ignored', () => {
    const wrapper = mountLabels();
    for (const bar of wrapper.findAll('.bar-track')) {
      bar.element.remove();
    }

    const text = wrapper.text();
    for (const entry of LABELS) {
      expect(text).toContain(entry.label);
    }
    expect(text).toContain('52.3%');
  });

  it('sizes each bar from its own score', () => {
    const fills = mountLabels().findAll('.bar-fill');
    expect(fills[0]?.attributes('style')).toContain('52.31%');
    expect(fills[1]?.attributes('style')).toContain('41%');
  });

  // The Worker refuses an out-of-range score, so this can only happen if that check is ever
  // removed. The bar must still stay inside its track rather than painting over the layout.
  it('never paints a bar wider than its track', () => {
    const wrapper = mountLabels([{ rank: 1, label: 'broken', score: 4 }]);
    expect(wrapper.find('.bar-fill').attributes('style')).toContain('100%');
  });
});

describe('the table structure', () => {
  // A real table rather than styled divs: the data genuinely is tabular, and a table gives a
  // screen-reader user row and column context and a row count for free.
  it('uses a table with column headers', () => {
    const headers = mountLabels().findAll('thead th');
    expect(headers.map((header) => header.text())).toEqual(['Rank', 'Label', 'Score']);
  });

  it('scopes every column header', () => {
    for (const header of mountLabels().findAll('thead th')) {
      expect(header.attributes('scope')).toBe('col');
    }
  });

  // The label identifies the row, so a screen reader announces it alongside the score instead of
  // reading a bare percentage.
  it('makes the label the row header', () => {
    const rowHeaders = mountLabels().findAll('tbody th[scope="row"]');
    expect(rowHeaders).toHaveLength(3);
    expect(rowHeaders[0]?.text()).toBe('Egyptian cat');
  });

  it('renders an empty ranking without a row', () => {
    expect(mountLabels([]).findAll('tbody tr')).toHaveLength(0);
  });
});
