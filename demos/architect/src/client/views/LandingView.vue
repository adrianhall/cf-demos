<script setup lang="ts">
/** Navigate to the Cloudflare Access logout endpoint without conditionally hiding recovery. */
function signOut(): void {
  window.location.assign("/cdn-cgi/access/logout");
}
</script>

<template>
  <v-container class="landing">
    <p class="eyebrow">Collaborative cloud design</p>
    <h1 class="title">Architecture, held in one room.</h1>
    <p class="summary">Build a Cloudflare architecture together, then publish an immutable view.</p>
    <div class="actions">
      <v-btn color="primary" href="/app">Open the editor</v-btn>
      <v-btn variant="text" @click="signOut">Sign out</v-btn>
    </div>
  </v-container>
</template>

<style scoped>
.landing { max-width: 760px; padding-block: 15vh; }
.eyebrow { color: rgb(var(--v-theme-primary)); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.title { font-size: clamp(2.7rem, 8vw, 5.5rem); line-height: 0.95; max-width: 700px; }
.summary { font-size: 1.2rem; max-width: 550px; }
.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 2rem; }
</style>
