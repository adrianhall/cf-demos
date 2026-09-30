import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { mount } from '@vue/test-utils';
import ChannelSidebar from '../../../src/client/components/ChannelSidebar.vue';

const vuetify = createVuetify({ components });

/**
 * Build a channel as the store holds one.
 *
 * @param name Channel name.
 * @returns A complete channel record.
 */
function channel(name: string) {
  return { name, createdBy: 'alice@example.com', createdAt: '2026-01-01T00:00:00.000Z' };
}

/**
 * Mount the sidebar with the supplied channels.
 *
 * @param channels Directory to render.
 * @param selected Currently connected channel.
 * @returns The mounted wrapper.
 */
function mountSidebar(channels = [channel('general')], selected: string | null = 'general') {
  return mount(ChannelSidebar, {
    global: { plugins: [vuetify] },
    props: { channels, selected }
  });
}

describe('ChannelSidebar', () => {
  it('lists every channel', () => {
    const wrapper = mountSidebar([channel('general'), channel('deploys')]);

    expect(wrapper.text()).toContain('general');
    expect(wrapper.text()).toContain('deploys');
  });

  it('shows an empty state rather than a blank list', () => {
    expect(mountSidebar([], null).text()).toContain('No channels yet');
  });

  it('requests a channel when it is clicked', async () => {
    const wrapper = mountSidebar([channel('general'), channel('deploys')]);
    await wrapper.findAll('.v-list-item')[1]?.trigger('click');

    expect(wrapper.emitted('select')?.[0]).toEqual(['deploys']);
  });

  // The remove button sits inside the clickable row, so without `@click.stop` removing a
  // channel would also select the channel it just removed.
  it('does not also select the channel when its remove button is used', async () => {
    const wrapper = mountSidebar([channel('general')]);
    await wrapper.find('.remove-button').trigger('click');

    expect(wrapper.emitted('remove')?.[0]).toEqual(['general']);
    expect(wrapper.emitted('select')).toBeUndefined();
  });

  it('marks the connected channel as current for assistive technology', () => {
    const wrapper = mountSidebar([channel('general'), channel('deploys')], 'deploys');
    const items = wrapper.findAll('.v-list-item');

    expect(items[0]?.attributes('aria-current')).toBeUndefined();
    expect(items[1]?.attributes('aria-current')).toBe('true');
  });

  it('emits the typed name and clears the field', async () => {
    const wrapper = mountSidebar();
    await wrapper.find('input').setValue('deploys');
    await wrapper.find('form').trigger('submit');

    expect(wrapper.emitted('create')?.[0]).toEqual(['deploys']);
    expect(wrapper.find<HTMLInputElement>('input').element.value).toBe('');
  });

  // Normalization belongs to the Worker; duplicating the rules here would create a second
  // definition to keep in sync. The component only trims for its own empty check.
  it('emits the name as typed rather than normalizing it locally', async () => {
    const wrapper = mountSidebar();
    await wrapper.find('input').setValue('  Deploys  ');
    await wrapper.find('form').trigger('submit');

    expect(wrapper.emitted('create')?.[0]).toEqual(['Deploys']);
  });

  it('ignores an empty submission', async () => {
    const wrapper = mountSidebar();
    await wrapper.find('input').setValue('   ');
    await wrapper.find('form').trigger('submit');

    expect(wrapper.emitted('create')).toBeUndefined();
  });

  it('labels the remove button with the channel it removes', () => {
    const wrapper = mountSidebar([channel('deploys')]);

    expect(wrapper.find('.remove-button').attributes('aria-label')).toBe('Remove channel: deploys');
  });
});
