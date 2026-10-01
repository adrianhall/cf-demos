<script setup lang="ts">
import { describeToken, revealWhitespace, type Token } from './tokenization';

const props = defineProps<{
  /**
   * Tokens to render, already capped by the composable.
   */
  tokens: Token[];
  /**
   * Total number of tokens, including any beyond those rendered, so each label can say "token 4 of
   * 912" truthfully.
   */
  totalTokens: number;
  /**
   * Whether to replace spaces, tabs, and newlines with visible marks.
   */
  showWhitespace: boolean;
}>();

/**
 * Number of distinct colours cycled across the sequence.
 *
 * Adjacent tokens must differ, but the palette does not need to be large: colour here separates
 * neighbours, it does not encode anything. Nothing is communicated by colour alone — every token is
 * also separated by a gap and an outline, and carries its own text label — so the sequence remains
 * readable when the colours are indistinguishable or absent entirely.
 */
const PALETTE_SIZE = 6;

/**
 * Chooses a token's colour class by position.
 *
 * @param index Token position in the sequence.
 * @returns A modifier class name cycling through the palette.
 */
function colourClass(index: number): string {
  return `token--c${index % PALETTE_SIZE}`;
}

/**
 * Text to display inside a token box.
 *
 * @param token The token to render.
 * @returns Its decoded text, with whitespace revealed when the toggle is on. A partial token has no
 *   text of its own, so it is drawn as a bullet rather than as an empty box a visitor would read as
 *   a rendering fault.
 */
function displayText(token: Token): string {
  if (token.partial) {
    return '◌';
  }
  return props.showWhitespace ? revealWhitespace(token.text) : token.text;
}
</script>

<template>
  <!--
    A list rather than a run of spans: a screen reader then announces how many tokens there are
    and lets the user step through them, which is the same information a sighted visitor gets from
    seeing the boxes.
  -->
  <ol class="token-sequence" aria-label="Token sequence">
    <li
      v-for="token in tokens"
      :key="token.index"
      class="token"
      :class="[colourClass(token.index), { 'token--partial': token.partial }]"
      :aria-label="describeToken(token, totalTokens)"
      :title="`ID ${token.id}`"
    >
      {{ displayText(token) }}
    </li>
  </ol>
</template>

<style scoped>
.token-sequence {
  display: flex;
  flex-wrap: wrap;
  /*
    The gap is load-bearing, not decorative: it is what separates one token from the next when the
    colours cannot be told apart, in a high-contrast mode, or on a monochrome printout.
  */
  gap: 0.1875rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.token {
  border: 1px solid rgb(var(--v-theme-outline-variant));
  border-radius: 0.25rem;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.875rem;
  line-height: 1.5;
  padding: 0.125rem 0.25rem;
  /* Preserve the token's own spaces and newlines so the sequence mirrors the original text. */
  white-space: pre-wrap;
}

.token--partial {
  border-style: dashed;
  color: rgb(var(--v-theme-on-surface-variant));
}

/*
  Six background tints at a low enough opacity that the inherited foreground colour keeps its
  contrast ratio against each of them.
*/
.token--c0 {
  background-color: rgba(138, 180, 255, 0.22);
}

.token--c1 {
  background-color: rgba(255, 183, 118, 0.22);
}

.token--c2 {
  background-color: rgba(149, 226, 176, 0.22);
}

.token--c3 {
  background-color: rgba(221, 160, 255, 0.22);
}

.token--c4 {
  background-color: rgba(255, 160, 180, 0.22);
}

.token--c5 {
  background-color: rgba(160, 226, 232, 0.22);
}
</style>
