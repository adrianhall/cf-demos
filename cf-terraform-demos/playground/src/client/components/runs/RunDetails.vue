<script setup lang="ts">
import { computed } from 'vue';
import type { RunMetrics, RunReceipt } from '../../../runs';

const props = defineProps<{
  /**
   * Receipt of the run being described.
   */
  receipt: RunReceipt;
  /**
   * Resolved gateway metrics, absent while the cost is still being polled for.
   */
  metrics?: RunMetrics | undefined;
  /**
   * Whether a metrics poll is currently in flight.
   */
  costPending: boolean;
}>();

/**
 * How the cost should be described right now.
 *
 * Deliberately a four-state label rather than a number with a fallback. `Pending`, `Unavailable`,
 * and a real figure are three different claims, and `$0.0000` is a fourth that this demo never
 * makes for an unmeasured run: a free-looking run and an unmeasured one would be
 * indistinguishable.
 */
const costLabel = computed(() => {
  const status = props.metrics?.costStatus ?? props.receipt.costStatus;

  if (status === 'available' && props.metrics?.totalCostUsd !== undefined) {
    return `$${props.metrics.totalCostUsd.toFixed(6)}`;
  }
  if (status === 'not-applicable') {
    return 'Not applicable';
  }
  if (status === 'unavailable') {
    return 'Unavailable';
  }
  return props.costPending ? 'Pending…' : 'Pending';
});

/**
 * Whether the gateway served any of this run's requests from its cache.
 */
const cached = computed(() => props.metrics?.requests.some((request) => request.cached) ?? false);

/**
 * Total reported input and output tokens, when the provider reported them.
 *
 * Absent rather than zero when unreported: a model billed per track or per second of audio has no
 * token counts, and a zero would read as "this used no tokens", which is a different claim.
 */
const tokens = computed(() => {
  const requests = props.metrics?.requests ?? [];
  const input = requests.reduce<number | undefined>(
    (total, request) => (request.tokensIn === undefined ? total : (total ?? 0) + request.tokensIn),
    undefined
  );
  const output = requests.reduce<number | undefined>(
    (total, request) =>
      request.tokensOut === undefined ? total : (total ?? 0) + request.tokensOut,
    undefined
  );

  return input === undefined && output === undefined ? undefined : { input, output };
});
</script>

<template>
  <section class="run-details" aria-labelledby="run-details-heading">
    <h3 id="run-details-heading" class="run-details-heading">Run details</h3>

    <dl class="details">
      <div class="detail">
        <dt>Model</dt>
        <dd>{{ receipt.model }}</dd>
      </div>
      <div class="detail">
        <dt>Routed through AI Gateway</dt>
        <dd>{{ receipt.gatewayRouted ? 'Yes' : 'No' }}</dd>
      </div>
      <div class="detail">
        <dt>Elapsed</dt>
        <dd>{{ receipt.elapsedMs.toLocaleString() }} ms</dd>
      </div>
      <!--
        `aria-live` on the cost, because it is the one value that changes after the answer has
        finished arriving. Without it the figure would appear silently for a screen-reader user who
        had already moved on.
      -->
      <div class="detail">
        <dt>Reported cost</dt>
        <dd aria-live="polite">{{ costLabel }}</dd>
      </div>
      <div v-if="metrics?.costStatus === 'available'" class="detail">
        <dt>Billing unit</dt>
        <dd>Per token, as reported by the gateway</dd>
      </div>
      <div v-if="tokens" class="detail">
        <dt>Tokens</dt>
        <dd>
          {{ tokens.input?.toLocaleString() ?? '—' }} in /
          {{ tokens.output?.toLocaleString() ?? '—' }} out
        </dd>
      </div>
      <div v-if="metrics && metrics.requests.length > 0" class="detail">
        <dt>Served from cache</dt>
        <dd>{{ cached ? 'Yes — no new provider charge' : 'No' }}</dd>
      </div>
      <!--
        The log identifier names a log record, not its contents, and this demo stores no payloads
        in those records. It is shown so a presenter can find the exact request in the AI Gateway
        dashboard.
      -->
      <div v-if="receipt.logIds.length > 0" class="detail detail--wide">
        <dt>Gateway log</dt>
        <dd class="log-id">{{ receipt.logIds.join(', ') }}</dd>
      </div>
    </dl>

    <p v-if="receipt.logIds.length === 0" class="note">
      The gateway did not report a log identifier for this run, so its cost cannot be looked up.
    </p>
    <p v-else-if="costLabel === 'Unavailable'" class="note">
      The gateway log did not arrive in time. The run itself succeeded; only its cost is unknown.
    </p>
  </section>
</template>

<style scoped>
.run-details {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 0.75rem;
  padding: 1rem 1.125rem;
}

.run-details-heading {
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin: 0 0 0.75rem;
  text-transform: uppercase;
}

.details {
  display: grid;
  gap: 0.625rem 1.5rem;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  margin: 0;
}

.detail--wide {
  grid-column: 1 / -1;
}

.detail dt {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
}

.detail dd {
  margin: 0;
}

.log-id {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}

.note {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0.875rem 0 0;
}
</style>
