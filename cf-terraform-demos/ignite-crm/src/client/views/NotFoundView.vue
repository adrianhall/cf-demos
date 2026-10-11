<script setup lang="ts">
/**
 * Unknown client route. Its title is the page's `h1`, so the shell's move-focus-to-heading on
 * navigation (and the document outline) work here like on every other page.
 */
</script>

<template>
  <section aria-labelledby="not-found-title">
    <v-empty-state text="That page does not exist.">
      <template #headline>
        <h1 id="not-found-title" class="text-h4">Page not found</h1>
      </template>
      <template #actions>
        <v-btn :to="{ name: 'dashboard' }" color="primary">Go to the dashboard</v-btn>
      </template>
    </v-empty-state>
  </section>
</template>
