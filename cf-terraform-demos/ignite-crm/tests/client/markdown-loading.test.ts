/**
 * @file The lazy Markdown boundary when its chunk fails to load: `MarkdownView` shows a retryable
 *   alert instead of raw text, `loadMarkdownRenderer` forgets the failure so a retry fetches again,
 *   and a stale render never overwrites a newer one. The renderer module is mocked so the chunk
 *   fetch can be made to fail and to resolve on demand.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import MarkdownView from '../../src/client/components/MarkdownView.vue';
import { createAppVuetify } from '../../src/client/vuetify.ts';

const state = vi.hoisted(() => ({ fail: true, calls: 0 }));

vi.mock('../../src/client/services/markdown-renderer.ts', () => {
  state.calls += 1;
  if (state.fail) {
    throw new Error('chunk failed to load');
  }
  return { renderMarkdown: () => '<p>rendered by the chunk</p>' };
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MarkdownView when the renderer chunk is unavailable', () => {
  it('shows a retryable alert, never the raw source, and recovers on retry', async () => {
    const wrapper = mount(MarkdownView, {
      props: { source: '<script>x</script>', label: 'Body' },
      global: { plugins: [createAppVuetify()] },
      attachTo: document.body
    });
    await flushPromises();
    await vi.dynamicImportSettled();
    await flushPromises();
    const alert = wrapper.get('[data-testid="markdown-error"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(wrapper.text()).not.toContain('<script>');

    state.fail = false;
    vi.resetModules();
    await alert.get('button').trigger('click');
    await flushPromises();
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(wrapper.find('[data-testid="markdown-error"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="markdown-view"]').text()).toBe('rendered by the chunk');
  });
});
