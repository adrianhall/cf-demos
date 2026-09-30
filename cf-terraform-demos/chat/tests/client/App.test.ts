import { describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { createTestingPinia } from '@pinia/testing';
import { mount } from '@vue/test-utils';
import App from '../../src/client/App.vue';
import { useSessionStore } from '../../src/client/stores/session';

const vuetify = createVuetify({ components });

/**
 * Mount the shell with a stubbed router view.
 *
 * @returns The mounted wrapper and the session store.
 */
function mountApp() {
  const pinia = createTestingPinia({ createSpy: vi.fn });
  const wrapper = mount(App, {
    global: { plugins: [pinia, vuetify], stubs: { 'router-view': true } }
  });
  return { wrapper, session: useSessionStore() };
}

describe('App', () => {
  it('requests the verified identity on mount', () => {
    const { session } = mountApp();
    expect(session.load).toHaveBeenCalled();
  });

  it('shows the verified identity once it is known', async () => {
    const { wrapper, session } = mountApp();
    session.email = 'alice@example.com';
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('alice@example.com');
  });

  it('shows progress while the identity is being verified', async () => {
    const { wrapper, session } = mountApp();
    session.loading = true;
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Verifying identity');
  });

  // The session lives in the Access cookie, so signing out is Access's job rather than
  // application state to clear.
  it('signs out through Cloudflare Access rather than application state', () => {
    const { wrapper } = mountApp();

    expect(wrapper.find('.logout-button').attributes('href')).toBe('/cdn-cgi/access/logout');
  });

  // Switching identity is how this demo is shown, so the control is never hidden behind a
  // signed-in state check.
  it('always offers the sign-out control', () => {
    const { wrapper } = mountApp();
    expect(wrapper.find('.logout-button').exists()).toBe(true);
  });
});
