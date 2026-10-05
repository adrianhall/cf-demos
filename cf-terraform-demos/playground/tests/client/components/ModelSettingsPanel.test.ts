/**
 * @file Tests for the collapsible model-settings panel. The behaviour worth pinning is the summary
 *   line. The settings collapsed to a heading that said only "Model settings" would hide the one
 *   fact a visitor needs while it is closed — which model is selected — and that fact is what
 *   justifies collapsing the section at all.
 */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ModelSettingsPanel from '../../../src/client/components/ModelSettingsPanel.vue';

/**
 * Mounts the panel with content in its slot.
 *
 * @param props Props to pass.
 * @returns The mounted wrapper.
 */
function mountPanel(props: { modelName?: string; modelId?: string; initiallyOpen?: boolean } = {}) {
  return mount(ModelSettingsPanel, {
    props,
    slots: { default: '<label for="x">Temperature</label><input id="x" />' }
  });
}

describe('ModelSettingsPanel', () => {
  // Collapsed because a visitor picks a model once and then runs several prompts against it, so
  // the expanded form is in the way for most of a visit.
  it('starts collapsed', () => {
    expect(mountPanel({ modelName: 'Rich Model' }).find('details').element.open).toBe(false);
  });

  it('can be asked to start expanded', () => {
    const wrapper = mountPanel({ modelName: 'Rich Model', initiallyOpen: true });
    expect(wrapper.find('details').element.open).toBe(true);
  });

  // The point of the summary: the selected model stays readable while the controls are hidden.
  it('names the selected model while collapsed', () => {
    const wrapper = mountPanel({ modelName: 'Llama 3.2 11B Vision' });
    expect(wrapper.find('summary').text()).toContain('Llama 3.2 11B Vision');
    expect(wrapper.find('summary').text()).toContain('Model settings');
  });

  it('updates the summary when the selection changes', async () => {
    const wrapper = mountPanel({ modelName: 'First Model' });
    await wrapper.setProps({ modelName: 'Second Model' });

    expect(wrapper.find('summary').text()).toContain('Second Model');
  });

  // The ID is technical reference material rather than a selector label. Showing it here keeps the
  // dropdown readable while giving the visitor the exact value they can copy into `cf ai run`.
  it('shows the full unmodified model ID in the expanded settings body', () => {
    const id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    const wrapper = mountPanel({ modelName: 'Llama 3.3 70B', modelId: id, initiallyOpen: true });

    expect(wrapper.find('[data-model-id]').text()).toBe(id);
  });

  // The contract is not merely "an ID appears"; it identifies the active model. The name and ID
  // props are supplied from the same selected-model lookup in every panel, so when a dropdown
  // changes both have to replace the old value rather than leaving stale copyable reference data.
  it('updates the displayed ID when the active model changes', async () => {
    const wrapper = mountPanel({ modelName: 'First Model', modelId: '@cf/example/first' });

    await wrapper.setProps({ modelName: 'Second Model', modelId: '@cf/example/second' });

    expect(wrapper.find('[data-model-id]').text()).toBe('@cf/example/second');
    expect(wrapper.text()).not.toContain('@cf/example/first');
  });

  // The catalogue is fetched after mount, so there is a first paint with no selection. An empty
  // bracket would read as a rendering fault rather than as a pending fetch.
  it('says the model is loading before the catalogue arrives', () => {
    const wrapper = mountPanel();

    expect(wrapper.find('summary').text()).toContain('loading');
    expect(wrapper.find('[data-model-id]').text()).toContain('loading');
  });

  it('renders the controls given to it', () => {
    expect(mountPanel({ modelName: 'Rich Model' }).find('#x').exists()).toBe(true);
  });

  // `<details>` carries its own expanded state in the accessibility tree and is keyboard
  // operable, which is why it was chosen over a button plus a `v-if`. Asserting on the element
  // keeps a later "tidy-up" from swapping in a div that looks the same and announces nothing.
  it('uses a native disclosure so the state is exposed and keyboard-operable', () => {
    const wrapper = mountPanel({ modelName: 'Rich Model' });
    expect(wrapper.find('details').exists()).toBe(true);
    expect(wrapper.find('summary').exists()).toBe(true);
  });

  it('expands when the summary is activated', async () => {
    const wrapper = mountPanel({ modelName: 'Rich Model' });
    await wrapper.find('summary').trigger('click');

    expect(wrapper.find('details').element.open).toBe(true);
  });
});
