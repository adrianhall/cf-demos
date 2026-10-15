import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from '../../src/client/App.vue';

/**
 * Minimal API router for the shell's requests.
 *
 * The shell issues several calls on mount, so a single scripted response is not enough; this maps a
 * path to its body and answers anything unmapped with an empty collection, which is the server's
 * own behaviour for a reader with nothing to see.
 *
 * @param routes Response bodies by path prefix.
 * @returns A `fetch` double.
 */
function stubFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const path = input.split('?')[0] ?? input;
      const body = routes[path] ?? {
        faqs: [],
        products: [],
        sources: [],
        jobs: [],
        escalations: []
      };
      return Promise.resolve(new Response(JSON.stringify(body)));
    })
  );
}

describe('SalesBot shell', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens mobile navigation with the keyboard and exposes a skip link', async () => {
    stubFetch({ '/api/me': { email: 'pm@example.com', role: 'pm' } });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('.menu-button').trigger('click');
    expect(wrapper.get('nav').classes()).toContain('open');
    expect(wrapper.get('.skip-link').attributes('href')).toBe('#main-content');
  });

  it('announces identity failures safely', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('offline'));
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Your identity could not be verified.');
  });

  it('closes the mobile menu after activating a destination', async () => {
    stubFetch({ '/api/me': { email: 'admin@example.com', role: 'administrator' } });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.get('.menu-button').trigger('click');
    await wrapper.get('.nav-link').trigger('click');
    expect(wrapper.get('nav').classes()).not.toContain('open');
  });

  it('hides the FAQ editor and administration from a salesperson', async () => {
    stubFetch({ '/api/me': { email: 'sales@example.com', role: 'salesperson' } });
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('#editor-heading').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Administration');
  });

  it('offers the FAQ editor to a PM', async () => {
    stubFetch({
      '/api/me': { email: 'pm@example.com', role: 'pm' },
      '/api/products': {
        products: [{ id: 'd1', name: 'D1', primaryPm: null, escalationTarget: null, active: true }]
      }
    });
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.get('#editor-heading').text()).toBe('Publish an FAQ');
    expect(wrapper.get('#faq-product').text()).toContain('D1');
  });

  it('offers a product-scoped dashboard to PMs with semantic metrics', async () => {
    stubFetch({
      '/api/me': { email: 'pm@example.com', role: 'pm' },
      '/api/dashboard': {
        metrics: {
          openCount: 1,
          byProduct: [{ productId: 'd1', openCount: 1 }],
          averageQueueAgeMs: 60_000,
          oldestQueueAgeMs: 60_000,
          averageFirstAnswerMs: null,
          averageResolutionMs: null,
          reassignmentCount: 0,
          rejectionCount: 0,
          staleFaqCount: 0,
          indexingBacklog: 0,
          failedIndexJobs: 0
        }
      }
    });
    const wrapper = mount(App);
    await flushPromises();
    await wrapper
      .findAll('.nav-link')
      .find((link) => link.text() === 'Dashboard')
      ?.trigger('click');
    await flushPromises();
    expect(wrapper.get('#dashboard-heading').text()).toBe('Web workflow health');
    expect(wrapper.get('caption').text()).toBe('Open queue by product');
    expect(wrapper.get('dl').text()).toContain('Open queue');
  });

  it('shows the administrator freshness view only after it is opened', async () => {
    stubFetch({
      '/api/me': { email: 'admin@example.com', role: 'administrator' },
      '/api/admin/index-jobs': {
        jobs: [
          {
            id: 'job-1',
            faqId: 'faq-1',
            faqRevision: 1,
            operation: 'upsert',
            searchDocumentId: null,
            status: 'pending',
            attempts: 0,
            lastError: null,
            updatedAt: '2026-10-15T00:00:00.000Z'
          }
        ]
      }
    });
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find('#freshness-heading').exists()).toBe(false);

    await wrapper.findAll('.nav-link')[2]?.trigger('click');
    await flushPromises();
    expect(wrapper.get('#freshness-heading').text()).toBe('Index freshness');
    // Stated as a word as well as a count, so the state is never carried by colour alone.
    expect(wrapper.text()).toContain('Pending');
    expect(wrapper.get('tbody').text()).toContain('faq-1');
  });
});
