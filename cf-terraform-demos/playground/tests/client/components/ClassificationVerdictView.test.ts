import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ClassificationVerdictView from '../../../src/client/components/results/ClassificationVerdictView.vue';
import type { ClassificationVerdict } from '../../../src/shared/classify-text';

/**
 * Mounts the component.
 *
 * @param verdict Verdict to render.
 * @param labelSetName Taxonomy name to show.
 * @returns The mounted wrapper.
 */
function render(verdict: ClassificationVerdict, labelSetName = 'Llama Guard 3 hazard taxonomy') {
  return mount(ClassificationVerdictView, { props: { verdict, labelSetName } });
}

/**
 * A safe verdict with no categories.
 */
const SAFE: ClassificationVerdict = { safe: true, categories: [], unrecognisedCategories: [] };

/**
 * An unsafe verdict citing two published categories.
 */
const UNSAFE: ClassificationVerdict = {
  safe: false,
  categories: [
    { code: 'S1', name: 'Violent Crimes' },
    { code: 'S10', name: 'Hate' }
  ],
  unrecognisedCategories: []
};

describe('the decision', () => {
  it('states a safe verdict in words', () => {
    expect(render(SAFE).text()).toMatch(/no category in this taxonomy was flagged/iu);
  });

  it('states an unsafe verdict in words', () => {
    expect(render(UNSAFE).text()).toMatch(/flagged against this taxonomy/iu);
  });

  // A red or green badge carrying the entire meaning fails for anyone who cannot distinguish
  // them, so the words do the work and colour only reinforces.
  it('does not rely on colour alone to convey the decision', () => {
    const safeText = render(SAFE).text();
    const unsafeText = render(UNSAFE).text();

    expect(safeText).not.toBe(unsafeText);
    expect(render(SAFE).find('.decision--safe').exists()).toBe(true);
    expect(render(UNSAFE).find('.decision--unsafe').exists()).toBe(true);
  });

  // `status` rather than `alert`: this is the result of an action the visitor took, not an
  // unexpected interruption.
  it('announces the decision as a status rather than an alert', () => {
    const decision = render(UNSAFE).find('.decision');

    expect(decision.attributes('role')).toBe('status');
  });

  it('hides the decorative marker from assistive technology', () => {
    expect(render(SAFE).find('.marker').attributes('aria-hidden')).toBe('true');
  });
});

describe('the absence of a score', () => {
  /**
   * The single most important property of this component.
   *
   * The model reports no confidence for its verdict, and a bar at 100% would be the most misleading
   * element the panel could draw.
   */
  it('shows no confidence figure anywhere', () => {
    const text = render(UNSAFE).text();

    expect(text).not.toMatch(/\d+(\.\d+)?%/u);
    expect(render(UNSAFE).find('.bar').exists()).toBe(false);
  });

  it('says explicitly that the model reports no score', () => {
    expect(render(SAFE).text()).toMatch(/reports no confidence score/iu);
  });
});

describe('the taxonomy', () => {
  it('names the taxonomy the verdict came from', () => {
    expect(render(UNSAFE).text()).toContain('Llama Guard 3 hazard taxonomy');
  });

  // The phase brief required that the categories not be presented as general-purpose labels.
  it('states that these are safety categories rather than topic labels', () => {
    expect(render(SAFE).text()).toMatch(/not general-purpose topic labels/iu);
  });
});

describe('the cited categories', () => {
  it('lists each category with its code and published name', () => {
    const wrapper = render(UNSAFE);

    expect(wrapper.findAll('.category')).toHaveLength(2);
    expect(wrapper.text()).toContain('S1');
    expect(wrapper.text()).toContain('Violent Crimes');
    expect(wrapper.text()).toContain('Hate');
  });

  it('shows no category list for a safe verdict', () => {
    expect(render(SAFE).find('.categories').exists()).toBe(false);
  });

  // A code outside the published set means the taxonomy has moved, which is worth surfacing.
  it('shows an unrecognised code without inventing a name for it', () => {
    const wrapper = render({
      safe: false,
      categories: [],
      unrecognisedCategories: ['S14']
    });

    expect(wrapper.find('.unrecognised').exists()).toBe(true);
    expect(wrapper.text()).toContain('S14');
    expect(wrapper.text()).toMatch(/not in the reviewed taxonomy/iu);
  });

  it('explains why an unrecognised code is shown as-is', () => {
    const wrapper = render({
      safe: false,
      categories: [],
      unrecognisedCategories: ['S14']
    });

    expect(wrapper.text()).toMatch(/no published name for/iu);
  });

  it('shows both recognised and unrecognised codes together', () => {
    const wrapper = render({
      safe: false,
      categories: [{ code: 'S1', name: 'Violent Crimes' }],
      unrecognisedCategories: ['S99']
    });

    expect(wrapper.findAll('.category')).toHaveLength(2);
    expect(wrapper.find('.category--unknown').exists()).toBe(true);
  });

  it('shows no unrecognised section when every code was known', () => {
    expect(render(UNSAFE).find('.unrecognised').exists()).toBe(false);
  });
});
