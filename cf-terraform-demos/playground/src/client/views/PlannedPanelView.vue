<script setup lang="ts">
import { computed } from 'vue';
import { findTask, type TaskId } from '../../tasks';
import PanelPage from '../components/PanelPage.vue';

const props = defineProps<{
  /**
   * Panel this placeholder stands in for, passed as a route prop by `router.ts`.
   */
  taskId: TaskId;
}>();

/**
 * Descriptor for the requested panel.
 *
 * Resolved rather than asserted: the router only ever supplies identifiers taken from the
 * catalogue, so this always finds a descriptor, but a template that handles `undefined` fails
 * gracefully where a non-null assertion would throw mid-navigation.
 */
const task = computed(() => findTask(props.taskId));
</script>

<template>
  <PanelPage v-if="task" :task="task">
    <!--
      A placeholder that states the phase rather than a vague "coming soon". A visitor reading
      "phase 7" against Classify Image can look at the implementation plan and see exactly what is
      planned and in what order, which is more useful than being told to wait.
    -->
    <section class="placeholder" aria-labelledby="placeholder-heading">
      <h2 id="placeholder-heading" class="placeholder-heading">Not built yet</h2>
      <p>
        This panel arrives in phase {{ task.phase }} of the Playground implementation plan. It is
        listed here from the start so the full shape of the product is visible, rather than the
        sidebar quietly growing as work lands.
      </p>
      <!--
        A placeholder that leaves a visitor with nowhere to go has wasted their click, so it points
        at the panels that do work: one that calls a model and one that does not. Each link is
        omitted on its own page, because inviting someone to visit the page they are already on is
        noise dressed as help.
      -->
      <p>
        In the meantime,
        <template v-if="task.id !== 'chat'">
          <router-link to="/chat">Chat</router-link>
          streams an answer from a real model and shows what it cost<template
            v-if="task.id !== 'view-tokens'"
            >, and
          </template>
        </template>
        <template v-if="task.id !== 'view-tokens'">
          <router-link to="/view-tokens">View Tokens</router-link>
          runs entirely in your browser at no cost </template
        >.
      </p>
    </section>
  </PanelPage>
</template>

<style scoped>
.placeholder {
  border: 1px dashed rgb(var(--v-theme-outline));
  border-radius: 0.75rem;
  max-width: 44rem;
  padding: 1.5rem;
}

.placeholder-heading {
  font-size: 1.125rem;
  margin: 0 0 0.75rem;
}

.placeholder p {
  margin: 0 0 0.75rem;
}

.placeholder p:last-child {
  margin-bottom: 0;
}
</style>
