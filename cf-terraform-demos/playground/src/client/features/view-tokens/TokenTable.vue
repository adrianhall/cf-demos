<script setup lang="ts">
import { escapeForTable, type Token } from './tokenization';

defineProps<{
  /**
   * Tokens to tabulate.
   */
  tokens: Token[];
}>();
</script>

<template>
  <!--
    The table is the non-visual equivalent of the coloured sequence, not an extra. Everything the
    boxes convey through colour and position is here as text: order, exact content with escapes,
    and the numeric identifier. It is also where a visitor reads an identifier they want to look
    up, which is impossible from a tooltip.
  -->
  <table class="token-table">
    <caption class="token-table-caption">
      Every token in order, with its exact text and vocabulary identifier
    </caption>
    <thead>
      <tr>
        <th scope="col" class="numeric">#</th>
        <th scope="col">Text</th>
        <th scope="col" class="numeric">Token ID</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="token in tokens" :key="token.index">
        <td class="numeric">{{ token.index + 1 }}</td>
        <td class="token-text">
          <template v-if="token.partial">
            <span class="partial">Part of a multi-byte character</span>
          </template>
          <template v-else>{{ escapeForTable(token.text) }}</template>
        </td>
        <td class="numeric">{{ token.id }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.token-table {
  border-collapse: collapse;
  width: 100%;
}

.token-table-caption {
  color: rgb(var(--v-theme-on-surface-variant));
  padding-bottom: 0.5rem;
  text-align: left;
}

.token-table th,
.token-table td {
  border-bottom: 1px solid rgb(var(--v-theme-outline-variant));
  padding: 0.3125rem 0.5rem;
  text-align: left;
}

.numeric {
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
  width: 1%;
}

.token-text {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
}

.partial {
  color: rgb(var(--v-theme-on-surface-variant));
  font-family: inherit;
  font-style: italic;
}
</style>
