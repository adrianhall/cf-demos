import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
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
}) {
  return mount(RunDetails, {
    props: {
      receipt: props.receipt ?? receipt(),
      ...(props.metrics === undefined ? {} : { metrics: props.metrics }),
      costPending: props.costPending ?? false
    }
  });
}

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

  it('shows a resolved cost at sub-cent precision', () => {
    expect(mountDetails({ metrics: metrics() }).text()).toContain('$0.000123');
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

  it('labels itself for assistive technology', () => {
    const section = mountDetails({}).find('section');
    expect(section.attributes('aria-labelledby')).toBe('run-details-heading');
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
