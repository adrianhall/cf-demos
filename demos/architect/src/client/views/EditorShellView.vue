<script setup lang="ts">
import { computed, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useSessionStore } from "../stores/session";

const session = useSessionStore();
const { email, error, loading } = storeToRefs(session);
const greeting = computed(() =>
  email.value
    ? `Signed in as ${email.value}`
    : "Confirming your Access identity",
);

/** Load the identity after the protected app shell mounts. */
onMounted(() => void session.load());

/** Always provide an Access logout path, including when identity verification fails. */
function signOut(): void {
  window.location.assign("/cdn-cgi/access/logout");
}
</script>

<template>
  <v-container class="shell">
    <header class="header">
      <div><p class="eyebrow">Architect</p><h1>Diagram library</h1></div>
      <v-btn variant="text" @click="signOut">Sign out</v-btn>
    </header>
    <v-card class="empty-state" variant="outlined">
      <v-card-text>
        <v-progress-circular v-if="loading" indeterminate color="primary" size="28" />
        <p v-else-if="error" class="error" role="alert">{{ error }}</p>
        <template v-else><h2>{{ greeting }}</h2><p>Your first shared diagram will appear here in Phase 2.</p></template>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<style scoped>
.shell { max-width: 1100px; padding-block: 3rem; }
.header { align-items: center; display: flex; justify-content: space-between; gap: 1rem; margin-bottom: 3rem; }
.eyebrow { color: rgb(var(--v-theme-primary)); font-weight: 700; letter-spacing: 0.08em; margin-bottom: 0.25rem; text-transform: uppercase; }
.empty-state { border-style: dashed; min-height: 260px; padding: 2rem; }
.error { color: rgb(var(--v-theme-error)); }
</style>
