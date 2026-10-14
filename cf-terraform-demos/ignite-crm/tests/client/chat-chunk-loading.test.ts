/**
 * @file The chat panel's loading boundary when its chunk cannot be fetched — typically after a
 *   deployment replaced the hashed files. The user must get the same explain-and-reload treatment
 *   the rest of the SPA gives a failed chunk, not an empty drawer. The panel module is mocked to
 *   throw, which is only possible in its own file: `vi.mock` is hoisted to the top of the module,
 *   so a failing mock cannot be scoped to one test among others. The same arrangement as
 *   `markdown-loading.test.ts`, for the same reason.
 */

import { describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { VApp } from 'vuetify/components';
import { flushPromises, mount } from '@vue/test-utils';
import LazyChatPanel from '../../src/client/components/chat/LazyChatPanel.vue';
import { createAppVuetify } from '../../src/client/vuetify.ts';

vi.mock('../../src/client/components/chat/ChatPanel.vue', () => {
  throw new Error('chunk failed to load');
});

describe('the chat panel when its chunk is unavailable', () => {
  it('explains the failure and offers a reload rather than showing an empty panel', async () => {
    const wrapper = mount(
      { render: () => h(VApp, () => h(LazyChatPanel)) },
      { attachTo: document.body, global: { plugins: [createAppVuetify()] } }
    );
    await flushPromises();
    await vi.dynamicImportSettled();
    await flushPromises();

    const alert = wrapper.get('[data-testid="chat-chunk-error"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toContain('newer version was just deployed');
    // The panel still closes, so a user is never stuck with a drawer they cannot dismiss.
    expect(wrapper.find('[data-testid="chat-close"]').exists()).toBe(true);
  });
});
