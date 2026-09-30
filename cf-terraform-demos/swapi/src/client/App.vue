<script setup lang="ts">
import { onMounted } from 'vue';
import ExplorerBanner from './components/ExplorerBanner.vue';
import { useSessionStore } from './stores/session';

const session = useSessionStore();

/**
 * Load the verified Access identity after the document mounts.
 *
 * The Explorer is usable while this request runs — identity is contextual rather than data needed
 * to render a collection — so the promise is intentionally not awaited and the banner reflects its
 * own loading state.
 */
onMounted(() => void session.load());
</script>

<template>
  <v-app>
    <ExplorerBanner />
    <v-main class="app-main">
      <router-view />
    </v-main>
  </v-app>
</template>

<style scoped>
.app-main {
  block-size: calc(100dvh - 4rem);
  min-block-size: 0;
}
</style>
