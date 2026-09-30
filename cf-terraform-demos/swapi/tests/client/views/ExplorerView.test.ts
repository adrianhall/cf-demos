import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { flushPromises, mount } from '@vue/test-utils';
import { useCatalogStore } from '../../../src/client/stores/catalog';
import ExplorerView from '../../../src/client/views/ExplorerView.vue';

/**
 * Mount the explorer with its real router because selecting a collection is a URL-changing action,
 * not merely a local visual state change.
 *
 * @returns The mounted explorer and its router.
 */
async function mountExplorer(): Promise<{
  router: ReturnType<typeof createRouter>;
  wrapper: ReturnType<typeof mount>;
}> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { component: ExplorerView, path: '/' },
      { component: ExplorerView, path: '/:type' }
    ]
  });
  await router.push('/');
  await router.isReady();

  const wrapper = mount(ExplorerView, {
    global: {
      plugins: [router, createVuetify({ components, directives })]
    }
  });

  return { router, wrapper };
}

describe('ExplorerView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // Selecting a collection starts its fetch through CollectionColumn. The navigation assertion is
    // independent of the network, so stubbing this keeps the test focused and offline.
    vi.spyOn(useCatalogStore(), 'loadCollection').mockResolvedValue();
  });

  it('routes a collection-selection event to the selected collection', async () => {
    const { router, wrapper } = await mountExplorer();

    wrapper.findComponent({ name: 'TypeNavigation' }).vm.$emit('select', 'films');
    await flushPromises();

    expect(router.currentRoute.value.path).toBe('/films');
  });
});
