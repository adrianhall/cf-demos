<script setup lang="ts">
/**
 * Frame for a panel: its title in the shell's header bar, its explanatory text behind an info
 * button, and its working area below.
 *
 * The header used to print the title, the task type, the summary, the gateway line, and a paragraph
 * of privacy disclosure before anything a visitor could use. Five blocks of equal emphasis meant
 * the thing the panel exists to do started below the fold, and the output of a run started below
 * that. Everything explanatory now lives in a modal reached from one button, which leaves the fold
 * for the work.
 *
 * Moving the description out of the page is not the same as hiding it. The info button sits beside
 * the title, the modal's text is unchanged, and the privacy disclosure a panel passes through the
 * `description` slot is still exactly one click from every panel that spends credit — the
 * `tests/client/privacy-claims.test.ts` guard holds it to that.
 */
import { ref } from 'vue';
import type { TaskDescriptor } from '../../shared/tasks';
import InfoButton from './InfoButton.vue';
import InfoDialog from './InfoDialog.vue';

const props = defineProps<{
  /**
   * The panel being rendered; supplies its name, technical task type, and summary.
   */
  task: TaskDescriptor;
}>();

/**
 * Whether the description modal is showing.
 */
const showAbout = ref(false);
</script>

<template>
  <article class="panel-page">
    <!--
      `defer` so the teleport resolves after the shell's header has rendered its target. Without
      it the child can mount before the slot exists in the DOM, and the title silently vanishes.

      Teleporting rather than passing the title up through a store: the title belongs to the route,
      and a store would need writing on every navigation and clearing on every unmount, with a
      stale title left over whenever that was missed.
    -->
    <Teleport defer to="#panel-title-slot">
      <div class="panel-identity">
        <h1 class="panel-title">{{ props.task.name }}</h1>
        <InfoButton
          class="about-button"
          :label="`About ${props.task.name}`"
          @activate="showAbout = true"
        />
      </div>
    </Teleport>

    <InfoDialog :open="showAbout" :title="props.task.name" @close="showAbout = false">
      <!--
        The technical task type is kept with the plain name rather than dropped. The action name is
        what someone picks from the sidebar; the task type is what they will search the model
        catalog for afterwards, so the modal is where the panel still teaches the vocabulary.
      -->
      <p class="about-task-type">{{ props.task.taskType }}</p>
      <p class="about-summary">{{ props.task.summary }}</p>
      <p v-if="props.task.gateway === 'required'" class="about-gateway">
        Routed through AI Gateway
      </p>
      <p v-else class="about-gateway about-gateway--local">
        Runs in your browser — no inference, no cost
      </p>

      <!--
        Where a panel puts anything else a visitor should read before their first request — for an
        inference panel, the credit and logging disclosure.
      -->
      <slot name="description" />
    </InfoDialog>

    <div class="panel-body">
      <slot />
    </div>
  </article>
</template>

<style scoped>
/*
  Wider than the old 64rem cap, because the panels now place the input and the output side by side
  and the pair needs the room. The cap stays so prose and single-column layouts do not stretch into
  unreadably long lines on a very wide display.
*/
.panel-page {
  margin: 0 auto;
  max-width: 90rem;
  padding: 1.25rem 1.25rem 3rem;
}

/*
  Scoped styles reach teleported content because the compiler puts the scope attribute on the
  element itself, and the teleport only moves where that element lands.
*/
.panel-identity {
  align-items: center;
  display: flex;
  gap: 0.5rem;
  min-width: 0;
}

/*
  Sized for a header bar rather than a page heading, and allowed to truncate: the bar also holds
  the identity and the sign-out control, and a long panel name must not push those off a narrow
  screen.
*/
.panel-title {
  font-size: 1.25rem;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.about-task-type {
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
}

.about-summary {
  margin: 0.75rem 0 0;
}

.about-gateway {
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.875rem;
  margin: 0.75rem 0 0;
}

.about-gateway::before {
  content: '→ ';
}

.about-gateway--local::before {
  content: '▣ ';
}
</style>
