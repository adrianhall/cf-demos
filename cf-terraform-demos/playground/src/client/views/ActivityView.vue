<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { CatalogueException } from '../stores/catalogue';
import { useLedgerStore } from '../stores/ledger';
import { useSessionStore } from '../stores/session';

const ledger = useLedgerStore();
const session = useSessionStore();

/**
 * Documented exceptions to the mandatory-gateway rule, read from the server's own register.
 *
 * The list comes from the API rather than being imported, because the authoritative register is the
 * one the Worker enforces. A browser-side copy could be stale in exactly the situation that
 * matters.
 */
const exceptions = ref<CatalogueException[]>([]);

/**
 * Whether the exception register has been read successfully.
 *
 * Distinguished from "the register is empty" on purpose: those look identical in a list but mean
 * opposite things. An empty register is a guarantee; a failed fetch is an unknown, and the page
 * must not render an unknown as a guarantee.
 */
const exceptionsLoaded = ref(false);

/**
 * Fetch the gateway exception register from the catalogue endpoint.
 *
 * @returns A promise fulfilled once the register has been read or the attempt has failed. A failure
 *   leaves `exceptionsLoaded` false so the page says it could not check, rather than claiming there
 *   are no exceptions.
 */
async function loadExceptions(): Promise<void> {
  try {
    const response = await fetch('/api/catalogue');
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as { gatewayExceptions: CatalogueException[] };
    exceptions.value = body.gatewayExceptions;
    exceptionsLoaded.value = true;
  } catch {
    exceptionsLoaded.value = false;
  }
}

onMounted(() => void loadExceptions());
</script>

<template>
  <article class="activity">
    <header>
      <h1>Activity and gateway</h1>
      <p class="subtitle">
        What this session has spent, and how the Playground handles your requests.
      </p>
    </header>

    <section aria-labelledby="session-heading">
      <h2 id="session-heading">This session</h2>
      <p v-if="!ledger.hasRuns">
        No inference runs yet. Nothing has been sent to a model from this browser session.
      </p>
      <dl v-else class="summary">
        <div>
          <dt>Runs</dt>
          <dd>{{ ledger.ledger.runCount }}</dd>
        </div>
        <div>
          <dt>Known cost</dt>
          <dd>${{ ledger.ledger.knownCostUsd.toFixed(4) }}</dd>
        </div>
        <div>
          <dt>Cost pending</dt>
          <dd>{{ ledger.ledger.pendingRuns }}</dd>
        </div>
        <div>
          <dt>Cost unavailable</dt>
          <dd>{{ ledger.ledger.unavailableRuns }}</dd>
        </div>
        <div>
          <dt>Served from cache</dt>
          <dd>{{ ledger.ledger.cachedRequests }}</dd>
        </div>
        <div>
          <dt>Sent to a provider</dt>
          <dd>{{ ledger.ledger.billedRequests }}</dd>
        </div>
      </dl>
      <p class="note">
        These totals live in this browser tab only. Closing it discards them; nothing is stored on
        the server.
      </p>
    </section>

    <section aria-labelledby="gateway-heading">
      <h2 id="gateway-heading">How requests are handled</h2>
      <ul class="facts">
        <li>
          Every inference request is routed through this demo's own AI Gateway. It is not an option
          or a setting — there is one place in the code that calls a model, and it always passes the
          gateway.
        </li>
        <li>
          Cost, token counts, cache state, and duration are read back from the gateway's log after
          the answer arrives. Nothing is estimated from token counts in the browser.
        </li>
        <li>
          A gateway log is written a moment after the answer, so a cost can show as
          <strong>Pending</strong> briefly. If it never arrives it shows as
          <strong>Unavailable</strong> — never as $0.00, which would read as free.
        </li>
        <li>
          Prompts, uploads, and model output are <strong>not</strong> stored in gateway logs. Each
          request asks the gateway to record metadata only.
        </li>
        <li>
          Your verified email <strong>is</strong> recorded in gateway metadata, so spending in this
          shared demo can be attributed to the person who caused it.
          <span v-if="session.email">
            Requests from this browser are attributed to {{ session.email }}.
          </span>
        </li>
        <li>
          View Tokens is the exception to all of the above because it is not inference at all: it
          tokenizes in your browser and never contacts a model.
        </li>
      </ul>
    </section>

    <section aria-labelledby="exceptions-heading">
      <h2 id="exceptions-heading">Gateway exceptions</h2>
      <p v-if="!exceptionsLoaded">Could not read the exception register.</p>
      <p v-else-if="exceptions.length === 0">
        None. Every inference path in this application goes through AI Gateway.
      </p>
      <ul v-else class="facts">
        <li v-for="exception in exceptions" :key="exception.id">
          <strong>{{ exception.panel }}</strong> — {{ exception.reason }}
        </li>
      </ul>
    </section>
  </article>
</template>

<style scoped>
.activity {
  margin: 0 auto;
  max-width: 54rem;
  padding: 1.5rem 1.25rem 3rem;
}

.activity h1 {
  font-size: 1.75rem;
  margin: 0;
}

.activity h2 {
  font-size: 1.125rem;
  margin: 2rem 0 0.75rem;
}

.subtitle {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0.25rem 0 0;
}

.summary {
  display: grid;
  gap: 0.5rem 1.5rem;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  margin: 0;
}

.summary dt {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.8125rem;
}

.summary dd {
  font-size: 1.125rem;
  font-weight: 700;
  margin: 0;
}

.facts {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  margin: 0;
  padding-left: 1.25rem;
}

.note {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 1rem 0 0;
}
</style>
