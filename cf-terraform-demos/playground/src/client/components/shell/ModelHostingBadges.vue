<script setup lang="ts">
/**
 * The pair of sidebar marks saying who runs a panel's models.
 *
 * It answers the question a presenter asks before a demo and a visitor asks before a first run:
 * _can I use this panel on this account?_ A Cloudflare-hosted model runs on the account as it
 * stands; a third-party model bills against Unified Billing credits, so a panel offering **only**
 * third-party models does nothing at all on an unfunded account. Showing both marks where both
 * apply is the point — the pair says "this works unfunded, and it also has paid options to compare
 * against", which neither mark alone conveys.
 *
 * Rendered from the task catalogue rather than from `/api/catalogue`, so the sidebar stays
 * synchronous and needs no fetch before it can draw navigation.
 */
import type { ModelHosting } from '../../../shared/tasks';

defineProps<{
  /**
   * Which provider classes back the panel's models. A panel with neither flag set renders no marks
   * at all, which is correct for the one panel that runs no model.
   */
  hosting: ModelHosting;
}>();
</script>

<template>
  <!--
    Each mark carries a real accessible name rather than only a `title`. The outgoing phase pill
    was text and so never needed one; a bare logo and a bare "3P" glyph both do, and a `title`
    alone is announced inconsistently and never reaches a touch user at all. The `title` is kept
    as well, because it is what a sighted mouse user gets.
  -->
  <span v-if="hosting.cloudflare || hosting.thirdParty" class="hosting-badges">
    <span
      v-if="hosting.cloudflare"
      class="hosting-badge"
      role="img"
      aria-label="Cloudflare-hosted models available"
      title="Cloudflare-hosted models available"
      data-hosting="cloudflare"
    >
      <!--
        Cloudflare's own mark, used with permission. Inlined rather than linked so the sidebar
        needs no extra request and the glyph inherits `currentColor` with the theme.
      -->
      <svg class="hosting-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727"
        />
      </svg>
    </span>
    <span
      v-if="hosting.thirdParty"
      class="hosting-badge hosting-badge--third-party"
      role="img"
      aria-label="Third-party models available, requires AI credits"
      title="Third-party models available, requires AI credits"
      data-hosting="third-party"
    >
      <span aria-hidden="true">3P</span>
    </span>
  </span>
</template>

<style scoped>
.hosting-badges {
  align-items: center;
  display: flex;
  flex: 0 0 auto;
  gap: 0.25rem;
}

.hosting-badge {
  align-items: center;
  color: rgb(var(--v-theme-on-surface-variant));
  display: flex;
  justify-content: center;
}

.hosting-icon {
  height: 1rem;
  width: 1rem;
}

.hosting-badge--third-party {
  border: 1px solid rgb(var(--v-theme-outline));
  border-radius: 999px;
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1;
  padding: 0.1875rem 0.3125rem;
}
</style>
