import { describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { createTestingPinia } from '@pinia/testing';
import { mount } from '@vue/test-utils';
import App from '../../src/client/App.vue';
import { useSessionStore } from '../../src/client/stores/session';

/**
 * Mount the shell with a stubbed router outlet and a mocked session store.
 *
 * @param email Identity the session store should report, or `null` for an unresolved session.
 * @returns The mounted wrapper and the mocked store.
 */
function mountApp(email: string | null = null) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: true });
  const store = useSessionStore(pinia);
  store.email = email;
  const wrapper = mount(App, {
    global: {
      plugins: [pinia, createVuetify({ components })],
      stubs: { 'router-view': true }
    }
  });
  return { store, wrapper };
}

describe('App', () => {
  it('requests the verified identity on mount', () => {
    const { store } = mountApp();
    expect(store.load).toHaveBeenCalledOnce();
  });

  it('displays the verified identity once resolved', async () => {
    const { wrapper } = mountApp('alice@example.com');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('alice@example.com');
  });

  // The session lives in the Cloudflare Access cookie, so signing out is Access's own endpoint
  // rather than any application state this app controls.
  it("links sign-out to Cloudflare Access's logout endpoint", () => {
    const { wrapper } = mountApp('alice@example.com');
    expect(wrapper.find('.logout-button').attributes('href')).toBe('/cdn-cgi/access/logout');
  });

  // Switching identity is the behaviour this demo exists to show, so the control must never be
  // conditional on the identity having resolved.
  it('always offers the sign-out control', () => {
    expect(mountApp(null).wrapper.find('.logout-button').exists()).toBe(true);
  });
});
