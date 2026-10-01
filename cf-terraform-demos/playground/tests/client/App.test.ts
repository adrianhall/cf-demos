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
      stubs: {
        'router-view': true,
        'router-link': { props: ['to'], template: '<a :href="to"><slot /></a>' }
      }
    }
  });
  return { store, wrapper };
}

describe('App', () => {
  it('requests the verified identity on mount', () => {
    const { store } = mountApp();
    expect(store.load).toHaveBeenCalledOnce();
  });

  // The shell displays the same email that every inference request records in AI Gateway
  // metadata, so showing it is also telling the visitor whose name appears against the spending.
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

  // Offered even before the identity resolves: a visitor whose session cannot be verified is
  // precisely the one who needs to sign out and try again.
  it('always offers the sign-out control', () => {
    expect(mountApp(null).wrapper.find('.logout-button').exists()).toBe(true);
  });

  it('renders the panel navigation and the session cost meter', () => {
    const { wrapper } = mountApp('alice@example.com');
    expect(wrapper.find('nav[aria-label="Playground panels"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('No inference runs yet');
  });

  // Landmarks let a keyboard or screen-reader user move between the panel list and the content
  // directly, instead of traversing fifteen links on every navigation.
  it('separates the sidebar and the content into landmarks', () => {
    const { wrapper } = mountApp();
    expect(wrapper.find('aside').exists()).toBe(true);
    expect(wrapper.find('main').exists()).toBe(true);
  });
});
