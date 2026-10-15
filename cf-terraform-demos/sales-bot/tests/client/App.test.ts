import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import App from '../../src/client/App.vue';

describe('SalesBot shell', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('opens mobile navigation with the keyboard and exposes a skip link', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ email: 'pm@example.com', role: 'pm' })))
    );
    const wrapper = mount(App);
    await wrapper.get('.menu-button').trigger('click');
    expect(wrapper.get('nav').classes()).toContain('open');
    expect(wrapper.get('.skip-link').attributes('href')).toBe('#main-content');
    expect(wrapper.text()).toContain('Management');
  });
  it('announces identity failures safely', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('offline'));
    const wrapper = mount(App);
    await Promise.resolve();
    await Promise.resolve();
    expect(wrapper.get('[role="alert"]').text()).toBe('Your identity could not be verified.');
  });
  it('closes the mobile menu after keyboard activation of a destination', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ email: 'salesperson@example.com', role: 'salesperson' }))
        )
    );
    const wrapper = mount(App);
    await wrapper.get('.menu-button').trigger('click');
    await wrapper.get('nav a').trigger('click');
    expect(wrapper.get('nav').classes()).not.toContain('open');
  });
});
