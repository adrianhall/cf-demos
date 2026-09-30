import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { flushPromises, mount } from '@vue/test-utils';
import CollectionColumn from '../../../src/client/components/CollectionColumn.vue';
import { useCatalogStore } from '../../../src/client/stores/catalog';

const NEAR_ID = '11111111-1111-1111-1111-111111111111';
const THOLOTHIAN_ID = '22222222-2222-2222-2222-222222222222';

/**
 * Mount a populated Species collection.
 *
 * @param selectedId Initially selected record.
 * @returns The component wrapper and scroll spy.
 */
async function mountCollection(selectedId: string | null): Promise<{
  scrollIntoView: ReturnType<typeof vi.fn>;
  wrapper: ReturnType<typeof mount>;
}> {
  const catalog = useCatalogStore();
  catalog.collections.species = {
    value: [
      { id: NEAR_ID, title: 'Aleena', subtitle: 'reptile' },
      { id: THOLOTHIAN_ID, title: 'Tholothian', subtitle: 'mammal' }
    ],
    loading: false,
    error: null
  };
  vi.spyOn(catalog, 'loadCollection').mockResolvedValue();
  const scrollIntoView = vi.fn();
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  Element.prototype.scrollIntoView = scrollIntoView;

  const wrapper = mount(CollectionColumn, {
    props: { typeId: 'species', selectedId },
    global: { plugins: [createVuetify({ components, directives })] }
  });
  await flushPromises();

  return { scrollIntoView, wrapper };
}

describe('CollectionColumn selection visibility', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('scrolls an initially selected relation target into view', async () => {
    const { scrollIntoView } = await mountCollection(THOLOTHIAN_ID);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });

  it('scrolls when selection changes within an already loaded collection', async () => {
    const { scrollIntoView, wrapper } = await mountCollection(NEAR_ID);
    scrollIntoView.mockClear();

    await wrapper.setProps({ selectedId: THOLOTHIAN_ID });
    await flushPromises();

    expect(scrollIntoView).toHaveBeenCalledOnce();
  });
});
