<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { TASK_DESCRIPTORS, type TaskDescriptor, type TaskGroup } from '../../../shared/tasks';
import ModelHostingBadges from './ModelHostingBadges.vue';

/**
 * `localStorage` key holding the groups a visitor has collapsed.
 *
 * Namespaced because the Playground shares an origin with nothing else today but may not always,
 * and an unprefixed `collapsed` would be an unpleasant thing to collide with.
 */
const COLLAPSED_STORAGE_KEY = 'playground.navigation.collapsed-groups';

/**
 * Panels bucketed by their visual group, in catalogue order.
 *
 * The grouping drives a disclosure per group. Each group renders as a heading containing a toggle
 * button, followed by the list of links that button governs. The navigation is still one level deep
 * — collapsing hides links, it never puts a panel _behind_ a group — and every group is open by
 * default, so the first paint shows the whole product.
 */
const groups = computed<{ name: TaskGroup; tasks: TaskDescriptor[] }[]>(() => {
  const ordered: { name: TaskGroup; tasks: TaskDescriptor[] }[] = [];
  for (const task of TASK_DESCRIPTORS) {
    const existing = ordered.find((group) => group.name === task.group);
    if (existing) {
      existing.tasks.push(task);
    } else {
      ordered.push({ name: task.group, tasks: [task] });
    }
  }
  return ordered;
});

/**
 * Reads the previously collapsed group names from `localStorage`.
 *
 * Every failure is swallowed deliberately. Storage can be absent, disabled by a privacy setting,
 * full, or hold something another version of this code wrote; none of those are reasons to render
 * no navigation. The fallback is the documented default state — everything expanded.
 *
 * @returns The stored group names, or an empty list when nothing usable is stored.
 */
function readCollapsedGroups(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(COLLAPSED_STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return [];
    }

    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Names of the groups currently collapsed.
 *
 * Held as the collapsed set rather than the expanded one so that a group added to the catalogue
 * later is expanded by default without needing a migration: it is simply absent from this list.
 */
const collapsedGroups = ref<string[]>(readCollapsedGroups());

// Persisted so a presenter who tidies the sidebar before a demo does not have it spring back open
// on the next reload. Writing is best-effort for the same reasons reading is.
watch(
  collapsedGroups,
  (value) => {
    try {
      globalThis.localStorage?.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // A visitor with storage disabled still gets working navigation; only the memory is lost.
    }
  },
  { deep: true }
);

/**
 * Reports whether a group is currently collapsed.
 *
 * @param group Group label to test.
 * @returns `true` when the group's panel list is hidden.
 */
function isCollapsed(group: TaskGroup): boolean {
  return collapsedGroups.value.includes(group);
}

/**
 * Opens or closes one group.
 *
 * @param group Group label whose disclosure was activated.
 * @returns Nothing; the group's state is flipped in place.
 */
function toggleGroup(group: TaskGroup): void {
  collapsedGroups.value = isCollapsed(group)
    ? collapsedGroups.value.filter((name) => name !== group)
    : [...collapsedGroups.value, group];
}

/**
 * Opens every group.
 *
 * This is the escape hatch: whatever state the sidebar is in, one click makes every panel visible
 * again. A collapsed group must never be the reason a panel cannot be found.
 *
 * @returns Nothing; the collapsed set is emptied.
 */
function expandAll(): void {
  collapsedGroups.value = [];
}

/**
 * Closes every group.
 *
 * @returns Nothing; every group label is added to the collapsed set.
 */
function collapseAll(): void {
  collapsedGroups.value = groups.value.map((group) => group.name);
}

/**
 * Builds the DOM id of a group's panel list, used as the toggle's `aria-controls` target.
 *
 * @param group Group label.
 * @returns A stable, lower-cased id unique within the navigation.
 */
function listId(group: TaskGroup): string {
  return `panel-group-${group.toLowerCase()}`;
}
</script>

<template>
  <nav class="panel-navigation" aria-label="Playground panels">
    <!--
      Expand-all and collapse-all, offered once for the whole list rather than per group. They are
      the reason collapsing is safe: a visitor who loses track of which groups they closed has a
      single obvious way back to the full product. Icon-only to keep them out of the way, so each
      carries a real accessible name rather than relying on a tooltip nobody can focus.
    -->
    <div class="group-controls">
      <button type="button" class="group-control" aria-label="Expand all groups" @click="expandAll">
        <svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M7 10l5 5 5-5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M4 4h16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <button
        type="button"
        class="group-control"
        aria-label="Collapse all groups"
        @click="collapseAll"
      >
        <svg class="control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M7 15l5-5 5 5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M4 20h16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>

    <template v-for="group in groups" :key="group.name">
      <!--
        The toggle lives *inside* the heading rather than replacing it. Replacing the `h2` with a
        `button` would make the group a control and nothing else, dropping the panel list out of
        heading navigation entirely — a screen-reader user would lose the fastest route to it in
        exchange for a disclosure they could already operate.
      -->
      <h2 class="group-heading">
        <button
          type="button"
          class="group-toggle"
          :aria-expanded="!isCollapsed(group.name)"
          :aria-controls="listId(group.name)"
          :data-group="group.name"
          @click="toggleGroup(group.name)"
        >
          <svg
            class="group-chevron"
            :class="{ 'group-chevron--collapsed': isCollapsed(group.name) }"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M8 10l4 4 4-4"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span class="group-name">{{ group.name }}</span>
        </button>
      </h2>
      <!--
        `v-show`, not `v-if`: `aria-controls` has to point at an element that exists, and a
        collapsed group should still be findable by the browser's own in-page search.
      -->
      <ul v-show="!isCollapsed(group.name)" :id="listId(group.name)" class="group-list">
        <li v-for="task in group.tasks" :key="task.id">
          <router-link
            :to="`/${task.id}`"
            class="panel-link"
            :data-task="task.id"
            active-class="panel-link--active"
          >
            <span class="panel-name">{{ task.name }}</span>
            <ModelHostingBadges :hosting="task.hosting" />
          </router-link>
        </li>
      </ul>
    </template>
  </nav>
</template>

<style scoped>
.panel-navigation {
  padding: 0.5rem 0.75rem 1.5rem;
}

.group-controls {
  display: flex;
  gap: 0.25rem;
  justify-content: flex-end;
  padding: 0.25rem 0;
}

.group-control {
  align-items: center;
  background: none;
  border: 1px solid transparent;
  border-radius: 0.5rem;
  color: rgb(var(--v-theme-on-surface-variant));
  cursor: pointer;
  display: flex;
  /* Comfortably above the 24x24 CSS-pixel minimum target size. */
  min-height: 2rem;
  min-width: 2rem;
  justify-content: center;
  padding: 0;
}

.group-control:hover,
.group-control:focus-visible {
  background-color: rgb(var(--v-theme-surface-variant));
  border-color: rgb(var(--v-theme-outline-variant));
}

.control-icon {
  height: 1.125rem;
  width: 1.125rem;
}

.group-heading {
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  margin: 1.25rem 0 0.375rem 0;
  text-transform: uppercase;
}

.group-toggle {
  align-items: center;
  background: none;
  border: none;
  border-radius: 0.5rem;
  color: rgb(var(--v-theme-on-surface-variant));
  cursor: pointer;
  display: flex;
  font: inherit;
  gap: 0.25rem;
  letter-spacing: inherit;
  /* Comfortably above the 24x24 CSS-pixel minimum target size. */
  min-height: 1.75rem;
  padding: 0.25rem 0.5rem;
  text-transform: inherit;
  width: 100%;
}

.group-toggle:hover,
.group-toggle:focus-visible {
  background-color: rgb(var(--v-theme-surface-variant));
}

.group-chevron {
  flex: 0 0 auto;
  height: 1rem;
  transition: transform 150ms ease;
  width: 1rem;
}

.group-chevron--collapsed {
  transform: rotate(-90deg);
}

/*
  The chevron's rotation is movement rather than a colour change, so a visitor who has asked for
  reduced motion gets the end state immediately. The rotation itself stays — it is what reports
  the collapsed state to a sighted visitor — only the animation between the two is dropped.
*/
@media (prefers-reduced-motion: reduce) {
  .group-chevron {
    transition: none;
  }
}

.group-name {
  flex: 1 1 auto;
  text-align: left;
}

.group-list {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  list-style: none;
  margin: 0;
  padding: 0;
}

.panel-link {
  align-items: center;
  border-radius: 0.5rem;
  color: rgb(var(--v-theme-on-surface));
  display: flex;
  gap: 0.5rem;
  /* Comfortably above the 24x24 CSS-pixel minimum target size, with room for a 16px label. */
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  text-decoration: none;
}

.panel-link:hover,
.panel-link:focus-visible {
  background-color: rgb(var(--v-theme-surface-variant));
}

.panel-link--active {
  background-color: rgb(var(--v-theme-surface-variant));
  font-weight: 700;
}

.panel-name {
  flex: 1 1 auto;
}
</style>
