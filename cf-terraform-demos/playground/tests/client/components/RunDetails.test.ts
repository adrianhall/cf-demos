import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import RunDetails from '../../../src/client/components/runs/RunDetails.vue';
import type { RunMetrics, RunReceipt } from '../../../src/runs';

/**
 * Builds a receipt.
 *
 * @param overrides Fields to replace on a pending single-log receipt.
 * @returns A receipt to render.
 */
function receipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
  return {
    runId: 'run-1',
    task: 'chat',
    model: '@cf/meta/llama-3.2-3b-instruct',
    gatewayRouted: true,
    logIds: ['log-abc'],
    status: 'completed',
    costStatus: 'pending',
    elapsedMs: 1_234,
    startedAt: '2026-04-01T09:15:00.000Z',
    ...overrides
  };
}

/**
 * Builds a metrics document.
 *
 * @param overrides Fields to replace on an available result.
 * @returns Metrics to render.
 */
function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runId: 'run-1',
    costStatus: 'available',
    totalCostUsd: 0.000_123,
    requests: [
      {
        logId: 'log-abc',
        model: '@cf/meta/llama-3.2-3b-instruct',
        provider: 'workers-ai',
        cached: false,
        success: true,
        durationMs: 310,
        costUsd: 0.000_123,
        tokensIn: 14,
        tokensOut: 52
      }
    ],
    ...overrides
  };
}

/**
 * Mounts the component.
 *
 * @param props Props to pass.
 * @returns The mounted wrapper.
 */
function mountDetails(props: {
  receipt?: RunReceipt;
  metrics?: RunMetrics;
  costPending?: boolean;
  embedded?: boolean;
}) {
  return mount(RunDetails, {
    props: {
      receipt: props.receipt ?? receipt(),
      ...(props.metrics === undefined ? {} : { metrics: props.metrics }),
      costPending: props.costPending ?? false,
      embedded: props.embedded ?? false
    }
  });
}

/**
 * Installs a recording Clipboard API.
 *
 * Jsdom does not provide `navigator.clipboard`, so the test supplies the same promise-returning
 * contract browsers expose. `navigator` itself is stubbed because its `clipboard` property is
 * readonly in some DOM implementations.
 *
 * @param implementation Clipboard write behaviour; defaults to success.
 * @returns The write spy.
 */
function stubClipboard(
  implementation: (text: string) => Promise<void> = () => Promise.resolve()
): ReturnType<typeof vi.fn<(text: string) => Promise<void>>> {
  const writeText = vi.fn(implementation);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  return writeText;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RunDetails', () => {
  it('shows the model and the measured duration', () => {
    const text = mountDetails({}).text();
    expect(text).toContain('@cf/meta/llama-3.2-3b-instruct');
    expect(text).toContain('1,234 ms');
  });

  // The whole claim of the demo, visible on every run rather than stated once in a README.
  it('states that the run was routed through AI Gateway', () => {
    expect(mountDetails({}).text()).toContain('Routed through AI Gateway');
  });

  it('shows the gateway log identifier so the request can be found in the dashboard', () => {
    expect(mountDetails({}).text()).toContain('log-abc');
  });

  // Explicitly placed in column two rather than spanning the list. On a fully populated run it is
  // the eighth item, balancing the two-column modal as four details per side.
  it('places the gateway log in the right-hand column', () => {
    expect(mountDetails({ metrics: metrics() }).find('.gateway-log-detail').classes()).toContain(
      'gateway-log-detail'
    );
  });

  it('shows a resolved cost at sub-cent precision', () => {
    expect(mountDetails({ metrics: metrics() }).text()).toContain('$0.000123');
  });

  // The unit is application-generated reference data. Repeating that the gateway reported it adds
  // nothing in a modal already devoted to one gateway-routed run.
  it('states the billing unit concisely', () => {
    const wrapper = mountDetails({ metrics: metrics() });
    const billing = wrapper
      .findAll('.detail')
      .find((detail) => detail.find('dt').text() === 'Billing unit');

    expect(billing?.find('dd').text()).toBe('Per token');
  });

  it('shows the reported token counts', () => {
    const text = mountDetails({ metrics: metrics() }).text();
    expect(text).toContain('14');
    expect(text).toContain('52');
  });

  // The four cost states are different claims and are rendered differently. A missing cost stays
  // missing rather than becoming a zero that reads as "free".
  it('shows Pending while the cost is being polled for', () => {
    expect(mountDetails({ costPending: true }).text()).toContain('Pending');
  });

  it('shows Unavailable when the cost will never resolve', () => {
    const text = mountDetails({ metrics: metrics({ costStatus: 'unavailable' }) }).text();
    expect(text).toContain('Unavailable');
  });

  it('never shows a zero cost for an unresolved run', () => {
    const text = mountDetails({ metrics: metrics({ costStatus: 'unavailable' }) }).text();
    expect(text).not.toContain('$0.00');
  });

  it('shows Not applicable for a run that performed no inference', () => {
    const text = mountDetails({ receipt: receipt({ costStatus: 'not-applicable' }) }).text();
    expect(text).toContain('Not applicable');
  });

  // A cache hit is the one case where a real answer legitimately costs nothing new, and it is
  // labelled as such rather than as an unmeasured cost.
  it('labels a cache hit as incurring no new charge', () => {
    const cached = metrics({
      requests: [{ ...metrics().requests[0]!, cached: true }]
    });
    expect(mountDetails({ metrics: cached }).text()).toContain('no new provider charge');
  });

  it('reports when no request was served from cache', () => {
    expect(mountDetails({ metrics: metrics() }).text()).toContain('Served from cache');
  });

  it('explains a run that produced no gateway log', () => {
    const text = mountDetails({
      receipt: receipt({ logIds: [], costStatus: 'unavailable' })
    }).text();
    expect(text).toMatch(/did not report a log identifier/iu);
  });

  it('explains that an unavailable cost does not mean the run failed', () => {
    const text = mountDetails({ metrics: metrics({ costStatus: 'unavailable' }) }).text();
    expect(text).toMatch(/run itself succeeded/iu);
  });

  // The cost is the one value that changes after the answer has finished arriving, so it is
  // announced rather than appearing silently.
  it('announces the cost politely when it resolves', () => {
    const wrapper = mountDetails({ metrics: metrics() });
    const live = wrapper.find('[aria-live="polite"]');
    expect(live.exists()).toBe(true);
    expect(live.text()).toContain('$0.000123');
  });

  it('labels its standalone presentation for assistive technology', () => {
    const wrapper = mountDetails({});
    const section = wrapper.find('section');
    expect(section.attributes('aria-labelledby')).toBe('run-details-heading');
    expect(wrapper.find('#run-details-heading').text()).toBe('Run details');
  });

  // The modal already owns the accessible name and rounded boundary. Repeating either inside it
  // creates a box inside a box and two adjacent headings with the same text.
  it('removes its own shell and title when embedded in a modal', () => {
    const wrapper = mountDetails({ embedded: true });
    const section = wrapper.find('section');

    expect(section.classes()).toContain('run-details--embedded');
    expect(section.attributes('aria-labelledby')).toBeUndefined();
    expect(wrapper.find('.run-details-heading').exists()).toBe(false);
  });

  it('omits token counts when the provider reported none', () => {
    const noTokens = metrics({
      requests: [
        {
          logId: 'log-abc',
          model: 'elevenlabs/music-v2',
          provider: 'elevenlabs',
          cached: false,
          success: true,
          durationMs: 9_100,
          costUsd: 0.02
        }
      ]
    });
    expect(mountDetails({ metrics: noTokens }).text()).not.toContain('Tokens');
  });

  it('sums the token counts of a multi-call run', () => {
    const multi = metrics({
      totalCostUsd: 0.000_246,
      requests: [
        { ...metrics().requests[0]!, logId: 'a' },
        { ...metrics().requests[0]!, logId: 'b' }
      ]
    });
    const text = mountDetails({ metrics: multi }).text();
    expect(text).toContain('28');
    expect(text).toContain('104');
  });
});

describe('copying the gateway log identifier', () => {
  it('offers a copy button when a log identifier exists', () => {
    const button = mountDetails({}).find('.copy-button');
    expect(button.exists()).toBe(true);
    expect(button.attributes('type')).toBe('button');
  });

  // The exact identifier in the name lets a screen-reader user distinguish copy controls if run
  // details ever appear together, and says what will be placed on the clipboard before activation.
  it('names the copy action and the identifier', () => {
    expect(mountDetails({}).find('.copy-button').attributes('aria-label')).toBe(
      'Copy gateway log identifier log-abc'
    );
  });

  it('copies the displayed identifier', async () => {
    const writeText = stubClipboard();
    const wrapper = mountDetails({});

    await wrapper.find('.copy-button').trigger('click');
    await flushPromises();

    expect(writeText).toHaveBeenCalledExactlyOnceWith('log-abc');
  });

  // Multi-call runs show a comma-separated list, so copying must copy that same complete value
  // rather than silently taking only the first identifier.
  it('copies every identifier from a multi-call run', async () => {
    const writeText = stubClipboard();
    const wrapper = mountDetails({ receipt: receipt({ logIds: ['log-a', 'log-b'] }) });

    await wrapper.find('.copy-button').trigger('click');
    await flushPromises();

    expect(wrapper.find('.log-id').text()).toBe('log-a, log-b');
    expect(writeText).toHaveBeenCalledExactlyOnceWith('log-a, log-b');
  });

  it('confirms a successful copy', async () => {
    stubClipboard();
    const wrapper = mountDetails({});

    await wrapper.find('.copy-button').trigger('click');
    await flushPromises();

    const status = wrapper.find('.copy-status');
    expect(status.attributes('role')).toBe('status');
    expect(status.text()).toBe('Copied');
  });

  // Clipboard permission can be denied. The failure is handled in place rather than becoming an
  // unhandled rejection, and visible feedback prevents a visitor from believing the copy worked.
  it('reports when the clipboard refuses the write', async () => {
    stubClipboard(() => Promise.reject(new Error('clipboard denied')));
    const wrapper = mountDetails({});

    await wrapper.find('.copy-button').trigger('click');
    await flushPromises();

    expect(wrapper.find('.copy-status').text()).toBe('Could not copy');
  });

  it('offers no copy control when no gateway log exists', () => {
    const wrapper = mountDetails({ receipt: receipt({ logIds: [] }) });
    expect(wrapper.find('.copy-button').exists()).toBe(false);
  });

  // A component instance can be reused for a later run. Its old success message must not claim the
  // new identifier was copied before the visitor has used the control again.
  it('clears old feedback when the receipt changes', async () => {
    stubClipboard();
    const wrapper = mountDetails({});
    await wrapper.find('.copy-button').trigger('click');
    await flushPromises();
    expect(wrapper.find('.copy-status').text()).toBe('Copied');

    await wrapper.setProps({ receipt: receipt({ runId: 'run-2', logIds: ['log-new'] }) });
    expect(wrapper.find('.copy-status').text()).toBe('');
  });
});
