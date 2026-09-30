import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { mount } from '@vue/test-utils';
import MessageComposer from '../../../src/client/components/MessageComposer.vue';

const vuetify = createVuetify({ components });

/**
 * Mount the composer.
 *
 * @param canSend Whether a connection is available to send on.
 * @returns The mounted wrapper.
 */
function mountComposer(canSend = true) {
  return mount(MessageComposer, { global: { plugins: [vuetify] }, props: { canSend } });
}

describe('MessageComposer', () => {
  it('emits a trimmed message and clears the field', async () => {
    const wrapper = mountComposer();
    await wrapper.find('input').setValue('  hello  ');
    await wrapper.find('form').trigger('submit');

    expect(wrapper.emitted('send')?.[0]).toEqual(['hello']);
    expect(wrapper.find<HTMLInputElement>('input').element.value).toBe('');
  });

  it('ignores a whitespace-only submission', async () => {
    const wrapper = mountComposer();
    await wrapper.find('input').setValue('   ');
    await wrapper.find('form').trigger('submit');

    expect(wrapper.emitted('send')).toBeUndefined();
  });

  // Disabling while reconnecting is what keeps a participant from typing into a void: a message
  // sent with no connection would simply be thrown away.
  it('disables the field and button when no connection is available', () => {
    const wrapper = mountComposer(false);

    expect(wrapper.find('input').attributes('disabled')).toBeDefined();
    expect(wrapper.find('button').attributes('disabled')).toBeDefined();
  });

  it('enables both controls once connected', () => {
    const wrapper = mountComposer(true);

    expect(wrapper.find('input').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('button').attributes('disabled')).toBeUndefined();
  });

  // Matches the domain's own bound, so the browser stops a participant before the room has to
  // reject the message.
  it('bounds input at the same length the domain enforces', () => {
    expect(mountComposer().find('input').attributes('maxlength')).toBe('2000');
  });
});
