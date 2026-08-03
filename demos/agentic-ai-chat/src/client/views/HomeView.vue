<script setup lang="ts">
import { useSessionStore } from "../stores/session";

const session = useSessionStore();
</script>

<template>
  <v-container class="home-view">
    <v-card v-if="session.isAuthenticated">
      <v-card-text>
        You're signed in. Chat features will appear here in a later phase of this demo -- see
        <code>docs/06-AGENTIC-CHAT.md</code> for the full implementation plan.
      </v-card-text>
    </v-card>
    <v-card v-else-if="session.error">
      <v-card-text>{{ session.error }}</v-card-text>
    </v-card>
  </v-container>
</template>

<style scoped>
.home-view {
  max-width: 56rem;
}
</style>
