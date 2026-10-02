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

  // The target a panel teleports its title into. A missing target does not throw — Vue warns and
  // renders nothing — so every panel would silently lose its heading, which is exactly the kind
  // of breakage that reaches production because nothing failed.
  it('offers the header slot a panel teleports its title into', () => {
    const { wrapper } = mountApp('alice@example.com');
    expect(wrapper.find('#panel-title-slot').exists()).toBe(true);
  });

  // Declared before the router outlet, so the target exists by the time a panel's deferred
  // teleport resolves. Reordering these would reintroduce the empty-header failure.
  //
  // Compared with `compareDocumentPosition` rather than by searching the rendered HTML for
  // "router-view": the outlet is stubbed, so it renders as `<router-view-stub>` and a substring
  // search finds the first mention of the name in a source comment instead of the element.
  //
  // The outlet is located through the stub rather than through `main`, because `main` is the
  // routed content's parent and comparing a parent to the title slot reports a containment
  // relationship rather than a simple before/after relationship.
  it('declares the title slot ahead of the routed panel', () => {
    const { wrapper } = mountApp('alice@example.com');
    const slot = wrapper.find('#panel-title-slot').element;
    const outlet = wrapper.find('router-view-stub').element;

    const relation = slot.compareDocumentPosition(outlet);
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(relation & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeFalsy();
  });

  // Exactly one main landmark. The shell used to wrap itself in Vuetify's `v-main` and render an
  // explicit `<main>` inside it, which nested the navigation sidebar inside main content and gave
  // landmark navigation two indistinguishable main regions.
  it('renders exactly one top-level main landmark', () => {
    const { wrapper } = mountApp();
    expect(wrapper.findAll('main')).toHaveLength(1);
    expect(wrapper.find('main').element.parentElement?.classList).toContain('content');
  });

  // Landmarks help a screen-reader user, while this gives a sighted keyboard user the equivalent
  // shortcut past the fifteen panel links — especially important when the sidebar stacks above the
  // content on a narrow screen.
  it('offers a skip link to the main content', () => {
    const { wrapper } = mountApp();
    const link = wrapper.find('.skip-link');
    expect(link.attributes('href')).toBe('#main-content');
    expect(wrapper.find('#main-content').exists()).toBe(true);
  });
});
