import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatComposer from '../../../src/client/features/chat/ChatComposer.vue';
import type { CatalogueModel } from '../../../src/client/stores/catalogue';

const MODELS: CatalogueModel[] = [
  {
    id: '@cf/example/model-a',
    name: 'Model A',
    provider: 'workers-ai',
    task: 'chat',
    pricingUnit: 'token',
    documentationUrl: 'https://example.com/a'
  },
  {
    id: '@cf/example/model-b',
    name: 'Model B',
    provider: 'workers-ai',
    task: 'chat',
    pricingUnit: 'token',
    documentationUrl: 'https://example.com/b'
  }
];

/**
 * Mounts the composer with controlled models.
 *
 * @param overrides Props to replace.
 * @returns The mounted wrapper.
 */
function mountComposer(
  overrides: Partial<{
    draft: string;
    model: string;
    temperature: number | undefined;
    canSend: boolean;
    streaming: boolean;
    hasConversation: boolean;
    hasRunDetails: boolean;
    showSampling: boolean;
  }> = {}
) {
  return mount(ChatComposer, {
    props: {
      'draft': '',
      'model': '@cf/example/model-a',
      'temperature': undefined,
      'models': MODELS,
      'canSend': false,
      'streaming': false,
      'hasConversation': false,
      'hasRunDetails': false,
      'showSampling': false,
      ...overrides,
      'onUpdate:draft': (value: string) => (overrides['draft'] = value),
      'onUpdate:model': (value: string) => (overrides['model'] = value),
      'onUpdate:temperature': (value: number | undefined) => (overrides['temperature'] = value)
    }
  });
}

describe('ChatComposer', () => {
  it('offers every reviewed model inside the composer, using descriptive names only', () => {
    const options = mountComposer().findAll('#model-select option');
    expect(options.map((option) => option.text())).toEqual(['Model A', 'Model B']);
    expect(options.map((option) => option.text()).join(' ')).not.toContain('@cf/');
  });

  it('shows the full unmodified ID of the active model beside the selector', () => {
    expect(mountComposer().find('[data-model-id]').text()).toBe('@cf/example/model-a');
  });

  // The component emits the dropdown's v-model update and reacts when its parent supplies the new
  // active value. The route-level test drives the complete loop through the real parent.
  it('updates the displayed model ID when its active-model prop changes', async () => {
    const wrapper = mountComposer();

    await wrapper.setProps({ model: '@cf/example/model-b' });

    expect(wrapper.find('[data-model-id]').text()).toBe('@cf/example/model-b');
    expect(wrapper.text()).not.toContain('@cf/example/model-a');
  });

  it('labels the message field and model selector', () => {
    const wrapper = mountComposer();
    expect(wrapper.find('label[for="chat-input"]').exists()).toBe(true);
    expect(wrapper.find('label[for="model-select"]').exists()).toBe(true);
  });

  it('disables Send for an empty draft', () => {
    expect(
      mountComposer().find('[aria-label="Send message"]').attributes('disabled')
    ).toBeDefined();
  });

  it('emits submit from the Send button', async () => {
    const wrapper = mountComposer({ draft: 'Hello', canSend: true });
    await wrapper.find('form').trigger('submit');
    expect(wrapper.emitted('submit')).toHaveLength(1);
  });

  it('sends on Enter', async () => {
    const wrapper = mountComposer({ draft: 'Hello', canSend: true });
    await wrapper.find('#chat-input').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('submit')).toHaveLength(1);
  });

  it('keeps Shift+Enter for a new line', async () => {
    const wrapper = mountComposer({ draft: 'Hello', canSend: true });
    await wrapper.find('#chat-input').trigger('keydown', { key: 'Enter', shiftKey: true });
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  // One stable node changes purpose, so keyboard focus is not discarded when sending starts.
  it('changes Send into Stop without replacing the control', async () => {
    const wrapper = mountComposer({ draft: 'Hello', canSend: true });
    const control = wrapper.find('.send-control').element;
    expect(wrapper.find('.send-control').attributes('aria-label')).toBe('Send message');

    await wrapper.setProps({ streaming: true });
    expect(wrapper.find('.send-control').element).toBe(control);
    expect(wrapper.find('.send-control').attributes('aria-label')).toBe('Stop generating');
  });

  it('emits cancel from Stop', async () => {
    const wrapper = mountComposer({ streaming: true });
    await wrapper.find('[aria-label="Stop generating"]').trigger('click');
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('shows Run details inside the composer only when a receipt exists', () => {
    expect(mountComposer().find('.run-details-button').exists()).toBe(false);
    expect(mountComposer({ hasRunDetails: true }).find('.run-details-button').exists()).toBe(true);
  });

  it('emits the Run details action', async () => {
    const wrapper = mountComposer({ hasRunDetails: true });
    await wrapper.find('.run-details-button').trigger('click');
    expect(wrapper.emitted('showRunDetails')).toHaveLength(1);
  });

  it('offers New chat only during an existing idle conversation', () => {
    expect(mountComposer().find('.new-chat-button').exists()).toBe(false);
    expect(mountComposer({ hasConversation: true }).find('.new-chat-button').exists()).toBe(true);
    expect(
      mountComposer({ hasConversation: true, streaming: true }).find('.new-chat-button').exists()
    ).toBe(false);
  });

  it('keeps sampling hidden until asked for', () => {
    expect(mountComposer().find('#temperature-input').isVisible()).toBe(false);
    expect(mountComposer({ showSampling: true }).find('#temperature-input').isVisible()).toBe(true);
  });

  it('emits a sampling toggle request', async () => {
    const wrapper = mountComposer();
    await wrapper.find('[aria-controls="sampling-options"]').trigger('click');
    expect(wrapper.emitted('toggleSampling')).toHaveLength(1);
  });
});
