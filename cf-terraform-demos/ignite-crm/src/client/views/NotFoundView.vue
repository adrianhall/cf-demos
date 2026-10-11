<script setup lang="ts">
/**
 * Unknown client route.
 */
</script>

<template>
  <v-empty-state headline="Page not found" text="That page does not exist.">
    <template #actions>
      <v-btn :to="{ name: 'dashboard' }" color="primary">Go to the dashboard</v-btn>
    </template>
  </v-empty-state>
</template>
