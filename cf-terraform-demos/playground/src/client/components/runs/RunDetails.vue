<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { RunMetrics, RunReceipt } from '../../../runs';

const props = withDefaults(
  defineProps<{
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
    /**
     * Whether the component is rendered inside a container that already supplies its title and
     * visual boundary, such as the Run details modal.
     *
     * The standalone Chat presentation keeps its own heading and border. A modal already has both,
     * so repeating them produces a box inside a box and two adjacent headings with the same text.
     */
    embedded?: boolean;
  }>(),
  { embedded: false }
);

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

/**
 * Text copied by the Gateway log control.
 *
 * A run can carry more than one gateway log when an operation makes several model calls. Copy all
 * identifiers in the same comma-separated form the component displays, so the button never copies a
 * different value from the one beside it.
 */
const gatewayLogIds = computed(() => props.receipt.logIds.join(', '));

/**
 * Feedback from the most recent copy attempt.
 *
 * Kept as visible text as well as a polite status announcement: clipboard permission can be denied,
 * and silently doing nothing would leave a visitor believing the identifier was copied.
 */
const copyStatus = ref<'copied' | 'failed' | undefined>(undefined);

/**
 * Copies the displayed gateway log identifier to the system clipboard.
 *
 * @returns A promise fulfilled after success or failure feedback has been rendered. Clipboard
 *   permission errors are handled in the component and are not thrown to the page.
 */
async function copyGatewayLog(): Promise<void> {
  try {
    await navigator.clipboard.writeText(gatewayLogIds.value);
    copyStatus.value = 'copied';
  } catch {
    copyStatus.value = 'failed';
  }
}

// A metrics update does not change the log identifiers, but a reused modal can be given a new
// receipt. Clear the old "Copied" message so it never describes an identifier that is no longer
// on screen.
watch(gatewayLogIds, () => {
  copyStatus.value = undefined;
});
</script>

<template>
  <section
    class="run-details"
    :class="{ 'run-details--embedded': props.embedded }"
    :aria-labelledby="props.embedded ? undefined : 'run-details-heading'"
  >
    <h3 v-if="!props.embedded" id="run-details-heading" class="run-details-heading">Run details</h3>

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
        <dd>Per token</dd>
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
        in those records. It is the final grid item rather than spanning both columns, which puts it
        on the right and balances a fully populated run as four items in each column.
      -->
      <div v-if="receipt.logIds.length > 0" class="detail gateway-log-detail">
        <dt>Gateway log</dt>
        <dd class="gateway-log-content">
          <span class="gateway-log-value">
            <code class="log-id">{{ gatewayLogIds }}</code>
            <button
              type="button"
              class="copy-button"
              :aria-label="`Copy gateway log identifier ${gatewayLogIds}`"
              title="Copy gateway log identifier"
              @click="copyGatewayLog"
            >
              <!--
                Two offset rectangles form a copy icon without adding an icon font. The button's
                accessible name carries the action and exact value, so the drawing is decorative.
              -->
              <span class="copy-icon" aria-hidden="true"></span>
            </button>
          </span>
          <span class="copy-status" role="status">
            <template v-if="copyStatus === 'copied'">Copied</template>
            <template v-else-if="copyStatus === 'failed'">Could not copy</template>
          </span>
        </dd>
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

/*
  The modal already supplies the title, padding, background, and rounded boundary. Remove the
  component's own shell there so the content becomes the modal body rather than a card nested
  inside another card.
*/
.run-details--embedded {
  border: none;
  border-radius: 0;
  padding: 0;
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
}

/*
  Keep the log in the right-hand list even when an optional field such as Tokens is absent. On a
  fully populated run it is the eighth item, balancing the modal as four details per column.
*/
.gateway-log-detail {
  grid-column: 2;
}

.detail dt {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
}

.detail dd {
  margin: 0;
}

.gateway-log-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.gateway-log-value {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  min-width: 0;
}

.log-id {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.8125rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

/*
  A compact but comfortably clickable icon button. The 28px transparent target stays above WCAG
  2.2's 24px minimum without drawing a second rounded box around a glyph that is already two
  outlined rectangles. The independent focus outline appears only for keyboard focus.
*/
.copy-button {
  align-items: center;
  background: none;
  border: none;
  color: rgb(var(--v-theme-on-surface-variant));
  cursor: pointer;
  display: inline-flex;
  flex: 0 0 auto;
  height: 1.75rem;
  justify-content: center;
  padding: 0;
  width: 1.75rem;
}

.copy-button:hover,
.copy-button:focus-visible {
  color: rgb(var(--v-theme-primary));
}

.copy-button:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}

/*
  Copy glyph drawn with borders so the component needs no icon package or webfont. The front and
  rear rectangles use currentColor, inheriting the hover/focus state from the button.
*/
.copy-icon {
  border: 1.5px solid currentcolor;
  border-radius: 0.125rem;
  box-sizing: border-box;
  height: 0.625rem;
  position: relative;
  transform: translate(0.125rem, 0.125rem);
  width: 0.625rem;
}

.copy-icon::before {
  border: 1.5px solid currentcolor;
  border-radius: 0.125rem;
  box-sizing: border-box;
  content: '';
  height: 0.625rem;
  left: -0.25rem;
  position: absolute;
  top: -0.25rem;
  width: 0.625rem;
}

.copy-status {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.75rem;
  min-height: 1.125rem;
  margin-top: 0.125rem;
}

.note {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0.875rem 0 0;
}

/* The modal remains two columns when it has room; on a phone each detail takes the full width. */
@media (max-width: 32rem) {
  .details {
    grid-template-columns: minmax(0, 1fr);
  }

  .gateway-log-detail {
    grid-column: auto;
  }
}
</style>
