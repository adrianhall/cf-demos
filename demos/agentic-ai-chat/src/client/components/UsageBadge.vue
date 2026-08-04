<script setup lang="ts">
import { ref, watch } from "vue";
import type {
  ChatUsageSummary,
  UsageReconciliationEvent,
} from "../composables/useChatAgent";

/**
 * A chat's cost/token readout (docs/06-AGENTIC-CHAT.md Section 6.6a, Phase 6, US-5): always
 * labeled **AI Gateway** or **Estimated** (or a mix, once this chat has both kinds of turns),
 * paired with a "N of M turns confirmed by AI Gateway" ratio -- so the mix is legible rather
 * than presenting a single number of ambiguous provenance (US-5's own acceptance criterion: the
 * two are never shown as indistinguishable numbers). Used both for the chat header's live,
 * push-updated total (`useChatStore.usage`/`lastReconciliationEvent`) and the sidebar's
 * REST-driven per-chat figure (`useChatsStore`'s `Chat.usage`) -- the latter simply never
 * passes {@link Props.lastReconciliationEvent}, since it has no live connection to animate a
 * transition for (Section 6.6a's documented asymmetry).
 */
interface Props {
  /** This chat's current cost/token totals. */
  usage: ChatUsageSummary;
  /** The most recent reconciliation transition to animate, or `null`/`undefined` when this
   * badge has no live connection to observe one (the sidebar's own per-chat figure). */
  lastReconciliationEvent?: UsageReconciliationEvent | null;
  /** Render a smaller, single-line variant for the sidebar's per-chat entry rather than the
   * chat header's fuller readout. */
  compact?: boolean;
}

const props = defineProps<Props>();

/** Which transition just occurred, briefly, so the badge can play a flip animation --
 * `null` the rest of the time. Cleared automatically after the animation's own duration. */
const flash = ref<"gateway" | "exhausted" | null>(null);

watch(
  () => props.lastReconciliationEvent,
  (event, previous) => {
    if (event === null || event === undefined) {
      return;
    }
    if (previous && previous.receivedAt === event.receivedAt) {
      return;
    }
    flash.value = event.type === "usage_reconciled" ? "gateway" : "exhausted";
    setTimeout(() => {
      // A later event replacing this one before the timer fires already set a fresh `flash`
      // value of its own -- only clear if this is still the flash that scheduled it.
      if (
        flash.value ===
        (event.type === "usage_reconciled" ? "gateway" : "exhausted")
      ) {
        flash.value = null;
      }
    }, 1_200);
  },
);

/** Format a USD amount for display -- four decimal places is enough precision to show a real
 * difference between this demo's own per-turn costs (typically well under a cent) without
 * rendering a wall of trailing zeros for a larger total. */
function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/** The badge's label and CSS class, given how many of this chat's turns are AI-Gateway-
 * confirmed versus still estimated. */
function sourceLabel(usage: ChatUsageSummary): string {
  if (usage.turnCount === 0) {
    return "No turns yet";
  }
  if (usage.confirmedTurnCount === usage.turnCount) {
    return "AI Gateway";
  }
  if (usage.confirmedTurnCount === 0) {
    return "Estimated";
  }
  return "Estimated + AI Gateway";
}

function sourceClass(usage: ChatUsageSummary): string {
  if (usage.turnCount === 0) {
    return "source-none";
  }
  if (usage.confirmedTurnCount === usage.turnCount) {
    return "source-gateway";
  }
  if (usage.confirmedTurnCount === 0) {
    return "source-estimated";
  }
  return "source-mixed";
}
</script>

<template>
  <div
    class="usage-badge"
    :class="{ compact, flashing: flash !== null }"
    role="status"
  >
    <span class="cost">{{ formatCost(usage.totalCostUsd) }}</span>
    <span v-if="!compact" class="tokens">
      {{ usage.totalPromptTokens }} in · {{ usage.totalCompletionTokens }} out
    </span>
    <span class="source-label" :class="sourceClass(usage)">
      {{ sourceLabel(usage) }}
    </span>
    <span v-if="!compact && usage.turnCount > 0" class="confirmation-ratio">
      {{ usage.confirmedTurnCount }} of {{ usage.turnCount }}
      {{ usage.turnCount === 1 ? "turn" : "turns" }} confirmed by AI Gateway
    </span>
  </div>
</template>

<style scoped>
.usage-badge {
  align-items: center;
  color: rgb(var(--v-theme-on-surface-variant));
  display: flex;
  flex-wrap: wrap;
  font-size: 0.8125rem;
  gap: 0.5rem;
}

.usage-badge.compact {
  font-size: 0.75rem;
  gap: 0.375rem;
}

.cost {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 600;
}

.source-label {
  border-radius: 0.25rem;
  font-weight: 600;
  padding: 0.0625rem 0.375rem;
}

.source-none {
  background: transparent;
  color: rgb(var(--v-theme-on-surface-variant));
  padding: 0;
}

.source-estimated {
  background: rgb(var(--v-theme-surface-variant));
  color: rgb(var(--v-theme-on-surface-variant));
}

.source-gateway {
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
}

.source-mixed {
  background: rgb(var(--v-theme-secondary));
  color: rgb(var(--v-theme-on-secondary));
}

.confirmation-ratio {
  color: rgb(var(--v-theme-on-surface-variant));
}

.usage-badge.flashing .source-label {
  animation: usage-badge-flash 1.2s ease-out;
}

@keyframes usage-badge-flash {
  0% {
    transform: scale(1.15);
  }
  100% {
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .usage-badge.flashing .source-label {
    animation: none;
  }
}
</style>
