<script setup lang="ts">
/**
 * Placeholder landing view for the authenticated shell built in Phase 1/2 of this demo. The
 * model selector, streaming transcript, and composer described in docs/05-AI-CHAT.md are added
 * in a later phase — this view exists so the Access-gated route has something to render today.
 */
</script>

<template>
  <v-alert class="placeholder" type="info" variant="tonal" role="status">
    You are signed in. The model playground (selector, streaming transcript, and composer) is
    added in a later implementation phase.
  </v-alert>
</template>

<style scoped>
.placeholder {
  margin: 1.5rem;
}
</style>
