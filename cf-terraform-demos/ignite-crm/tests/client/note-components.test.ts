/**
 * @file The three reusable notes components in the DOM with a real Vuetify instance, as library
 *   components would be tested: `RecordLinkChooser` (typed search, keyboard add, labelled chip
 *   removal, item errors, search event), `MarkdownComposer` (write/preview toggle, byte counter,
 *   size error), and `MarkdownView` (safe rendering as a labelled region).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import MarkdownComposer from '../../src/client/components/MarkdownComposer.vue';
import MarkdownView from '../../src/client/components/MarkdownView.vue';
import RecordLinkChooser from '../../src/client/components/RecordLinkChooser.vue';
import type { LinkOption } from '../../src/client/services/note-draft.ts';
import { createAppVuetify } from '../../src/client/vuetify.ts';
import { settle } from './support.ts';

const ADA: LinkOption = {
  type: 'contact',
  id: '00000000-0000-4000-8000-0000000000a1',
  label: 'Ada'
};
const BEN: LinkOption = {
  type: 'contact',
  id: '00000000-0000-4000-8000-0000000000a2',
  label: 'Ben'
};
const ACME: LinkOption = {
  type: 'company',
  id: '00000000-0000-4000-8000-0000000000b1',
  label: 'Acme'
};

/**
 * Mount the chooser around a real `v-model`.
 *
 * @param props Extra props.
 * @param initial Initial selection.
 * @returns The wrapper, the model, and the search handler.
 */
function mountChooser(props: Record<string, unknown> = {}, initial: LinkOption[] = []) {
  const model = ref<LinkOption[]>(initial);
  const onSearch = vi.fn();
  const wrapper = mount(
    {
      render: () =>
        h(RecordLinkChooser, {
          'label': 'Linked records',
          'results': [ADA, BEN],
          'modelValue': model.value,
          'onUpdate:modelValue': (value: LinkOption[]) => {
            model.value = value;
          },
          onSearch,
          ...props
        })
    },
    { attachTo: document.body, global: { plugins: [createAppVuetify()] } }
  );
  return { wrapper, model, onSearch };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('RecordLinkChooser', () => {
  it('debounces a search event for the chosen type and text', async () => {
    vi.useFakeTimers();
    const { wrapper, onSearch } = mountChooser();
    vi.advanceTimersByTime(300);
    expect(onSearch).toHaveBeenLastCalledWith('contact', '');
    await wrapper.get('input[role="searchbox"]').setValue('  ad ');
    vi.advanceTimersByTime(100);
    await wrapper.get('input[role="searchbox"]').setValue('  ada ');
    vi.advanceTimersByTime(300);
    expect(onSearch).toHaveBeenLastCalledWith('contact', 'ada');
    expect(onSearch).toHaveBeenCalledTimes(2);
  });

  it('adds with an Add button or Enter, hides chosen results, and removes with a labelled button', async () => {
    const { wrapper, model } = mountChooser();
    await settle();
    const add = wrapper.get('button[aria-label="Link contact Ada"]');
    await add.trigger('click');
    expect(model.value).toEqual([ADA]);
    expect(wrapper.find('button[aria-label="Link contact Ada"]').exists()).toBe(false);
    // Enter in the search adds the first remaining result instead of submitting a form.
    const searchbox = wrapper.get('input[role="searchbox"]');
    await searchbox.trigger('keydown', { key: 'Enter' });
    expect(model.value).toEqual([ADA, BEN]);
    expect(wrapper.get('[data-testid="link-results"]').text()).toContain(
      'No matching contact records'
    );
    expect(wrapper.get('[role="list"]').attributes('aria-label')).toBe('Linked records: 2 chosen');
    await wrapper.get('button[aria-label="Remove Ada"]').trigger('click');
    expect(model.value).toEqual([BEN]);
  });

  it('shows the empty state, set-level errors, per-item errors, and tombstones', async () => {
    const empty = mountChooser({ errorMessages: ['Link the note to at least one record.'] });
    expect(empty.wrapper.text()).toContain('Nothing linked yet.');
    expect(empty.wrapper.get('[role="alert"]').text()).toBe(
      'Link the note to at least one record.'
    );
    empty.wrapper.unmount();

    const { wrapper } = mountChooser(
      { itemErrors: { 1: 'This record does not exist or is no longer available.' } },
      [ADA, { ...ACME, available: false }]
    );
    expect(wrapper.text()).toContain('Acme');
    expect(wrapper.text()).toContain('(deleted)');
    expect(wrapper.text()).toContain('This record does not exist or is no longer available.');
  });

  it('shows a failed search with a retry action, not an empty-result claim', async () => {
    const { wrapper, onSearch } = mountChooser({
      results: [],
      searchError: 'The data service is temporarily unavailable.'
    });
    expect(wrapper.text()).toContain('Could not search records');
    expect(wrapper.text()).not.toContain('No matching contact records');
    await wrapper
      .findAll('button')
      .find((candidate) => candidate.text() === 'Retry search')!
      .trigger('click');
    expect(onSearch).toHaveBeenCalledWith('contact', '');
  });

  it('disables every control while saving', async () => {
    const { wrapper } = mountChooser({ disabled: true }, [ADA]);
    await flushPromises();
    expect(wrapper.get('fieldset').attributes()).toHaveProperty('disabled');
    expect(wrapper.get('input[role="searchbox"]').attributes()).toHaveProperty('disabled');
  });
});

describe('MarkdownComposer', () => {
  it('switches between writing and a rendered preview, keyboard-operable', async () => {
    const model = ref('# Plan\n\n- [ ] Call <b>Ada</b>');
    const wrapper = mount(
      {
        render: () =>
          h(MarkdownComposer, {
            'label': 'Body',
            'modelValue': model.value,
            'onUpdate:modelValue': (value: string) => {
              model.value = value;
            }
          })
      },
      { attachTo: document.body, global: { plugins: [createAppVuetify()] } }
    );
    expect(wrapper.get('textarea').element.value).toContain('# Plan');
    expect(wrapper.text()).toContain('0.0 of 64 KiB');
    const preview = wrapper.findAll('button').find((button) => button.text() === 'Preview')!;
    expect(preview.element.tagName).toBe('BUTTON');
    await preview.trigger('click');
    await settle();
    const rendered = wrapper.get('[data-testid="markdown-preview"]');
    expect(rendered.find('h3').text()).toBe('Plan');
    expect(rendered.find('b').exists()).toBe(false);
    expect(rendered.text()).toContain('<b>Ada</b>');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Write')!
      .trigger('click');
    await wrapper.get('textarea').setValue('');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Preview')!
      .trigger('click');
    expect(wrapper.text()).toContain('Nothing to preview yet.');
  });

  it('reports a body over 64 KiB, measured in UTF-8 bytes', async () => {
    const wrapper = mount(MarkdownComposer, {
      props: { label: 'Body', modelValue: 'é'.repeat(32 * 1024 + 1), errorMessages: [] },
      attachTo: document.body,
      global: { plugins: [createAppVuetify()] }
    });
    await settle();
    expect(wrapper.text()).toContain('Body must be at most 64 KiB.');
    expect(wrapper.text()).toContain('64.0 of 64 KiB');
  });
});

describe('MarkdownView', () => {
  it('shows a busy skeleton, then renders sanitised Markdown inside a labelled region', async () => {
    const source = ref('**Hi** [x](javascript:alert(1))');
    const wrapper = mount(
      { render: () => h(MarkdownView, { source: source.value, label: 'Kick-off (note body)' }) },
      { global: { plugins: [createAppVuetify()] } }
    );
    // The renderer chunk has not resolved yet on the first synchronous render.
    expect(wrapper.get('[data-testid="markdown-loading"]').attributes('aria-busy')).toBe('true');
    await settle();
    const region = wrapper.get('[data-testid="markdown-view"]');
    expect(region.attributes('role')).toBe('region');
    expect(region.attributes('aria-label')).toBe('Kick-off (note body)');
    expect(region.find('strong').text()).toBe('Hi');
    expect(region.find('a').exists()).toBe(false);

    // A new source re-renders without going back to the skeleton.
    source.value = '_updated_';
    await settle();
    expect(wrapper.get('[data-testid="markdown-view"] em').text()).toBe('updated');
  });
});
