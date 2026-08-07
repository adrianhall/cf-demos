<script setup lang="ts">
import { onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "../components/FeatherIcon.vue";
import { useInvitationRedemptionStore } from "../stores/invitation-redemption";

/**
 * `/app/invitations/:token` — redeems an editor invitation for the signed-in Access identity.
 *
 * This is a protected page: Cloudflare Access already authenticated the request before the
 * Worker or this SPA route is ever reached (`/app(?:\/|$)` in `../../access-policies.ts` already
 * covers this sub-path). That makes it a deliberately different mechanism from Phase 6's public
 * `/share#<token>` fragment-token viewer: this route's token is a single-use, D1-backed
 * capability that grants durable `diagram_members` access, not a read-only anonymous view.
 */
const route = useRoute();
const router = useRouter();
const store = useInvitationRedemptionStore();

onMounted(async () => {
  const diagramId = await store.redeem(String(route.params.token));
  if (diagramId) {
    await router.push({ name: "diagram-editor", params: { id: diagramId } });
  }
});
</script>

<template>
  <v-container class="redeem">
    <header class="toolbar">
      <h1 class="title">Diagram invitation</h1>
      <v-spacer />
      <v-btn variant="text" href="/cdn-cgi/access/logout">
        <template #prepend><FeatherIcon name="log-out" /></template>
        Sign out
      </v-btn>
    </header>

    <div class="status">
      <v-progress-circular v-if="store.pending" color="primary" indeterminate />
      <v-alert v-else-if="store.error" type="error" variant="tonal">
        <template #title>This invitation could not be redeemed</template>
        {{ store.error }}
      </v-alert>
    </div>
  </v-container>
</template>

<style scoped>
.redeem {
  padding-block: 2rem;
}
.toolbar {
  align-items: center;
  display: flex;
  gap: 0.75rem;
  margin-bottom: 2rem;
}
.title {
  font-size: 1.1rem;
  margin: 0;
}
.status {
  align-items: center;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  justify-content: center;
  min-block-size: 40vh;
  text-align: center;
}
</style>
