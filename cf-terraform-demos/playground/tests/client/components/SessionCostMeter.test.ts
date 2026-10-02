import { describe, expect, it, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { mount } from '@vue/test-utils';
import SessionCostMeter from '../../../src/client/components/shell/SessionCostMeter.vue';
import { useLedgerStore } from '../../../src/client/stores/ledger';
import type { SessionCostLedger } from '../../../src/shared/runs';

/**
 * Mount the cost meter with a ledger in a chosen state.
 *
 * @param ledger Partial ledger values to apply over the empty default.
 * @returns The mounted wrapper.
 */
function mountMeter(ledger: Partial<SessionCostLedger> = {}) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: true });
  const store = useLedgerStore(pinia);
  store.ledger = { ...store.ledger, ...ledger };

  return mount(SessionCostMeter, {
    global: {
      plugins: [pinia],
      stubs: { 'router-link': { props: ['to'], template: '<a :href="to"><slot /></a>' } }
    }
  });
}

describe('SessionCostMeter', () => {
  // The meter is mounted from the first screen rather than appearing once spending begins. A cost
  // indicator a visitor only notices after they have spent money has failed at its job.
  it('states explicitly that no runs have happened yet', () => {
    const wrapper = mountMeter();
    expect(wrapper.text()).toContain('No inference runs yet');
  });

  // "$0.00" and "no runs yet" look similar and mean entirely different things. Showing a zero
  // before anything has happened would start the session with a misleading number.
  it('shows no monetary total before the first run', () => {
    expect(mountMeter().text()).not.toContain('$');
  });

  it('shows the known total once runs exist', () => {
    const wrapper = mountMeter({ runCount: 2, knownCostUsd: 0.0123 });
    expect(wrapper.text()).toContain('$0.0123');
    expect(wrapper.text()).not.toContain('No inference runs yet');
  });

  // Inference costs are routinely fractions of a cent. Two decimal places would render almost
  // every genuine figure as "$0.00" — exactly the confusion the meter exists to prevent.
  it('shows sub-cent costs at a precision that does not round them away', () => {
    expect(mountMeter({ runCount: 1, knownCostUsd: 0.000_18 }).text()).toContain('$0.0002');
  });

  // Unresolved runs are counted beside the total, never inside it. A total that silently omits a
  // run is a wrong number wearing the appearance of a right one.
  it('counts pending and unavailable runs separately from the total', () => {
    const wrapper = mountMeter({
      runCount: 3,
      knownCostUsd: 0.005,
      pendingRuns: 1,
      unavailableRuns: 1
    });
    expect(wrapper.text()).toContain('Cost pending');
    expect(wrapper.text()).toContain('Cost unavailable');
  });

  it('reports cache hits when some requests were served from cache', () => {
    const wrapper = mountMeter({ runCount: 2, knownCostUsd: 0.001, cachedRequests: 1 });
    expect(wrapper.text()).toContain('Served from cache');
  });

  it('links to the activity page', () => {
    expect(mountMeter().find('a[href="/activity"]').exists()).toBe(true);
  });

  it('labels itself for assistive technology', () => {
    const section = mountMeter().find('section');
    expect(section.attributes('aria-labelledby')).toBe('cost-meter-heading');
  });
});
