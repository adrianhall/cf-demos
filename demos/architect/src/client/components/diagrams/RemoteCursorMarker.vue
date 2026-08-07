<script setup lang="ts">
import type { ParticipantRole } from "../../../collaboration-protocol";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import FeatherIcon from "../FeatherIcon.vue";

/**
 * One remote collaborator's cursor marker.
 *
 * Purely presentational: `DiagramCanvas.vue` computes `left`/`top` (screen pixels, already
 * accounting for the local viewer's own pan/zoom) and passes them straight through as inline
 * styles — this component owns no coordinate math itself.
 */
defineProps<{
  /** Verified Cloudflare Access email shown as the cursor's label. */
  email: string;
  /** Colors the marker distinctly for an owner vs. an editor, matching `MemberList.vue`'s convention. */
  role: ParticipantRole;
  /** Screen-space horizontal position, in pixels, relative to the canvas container. */
  left: number;
  /** Screen-space vertical position, in pixels, relative to the canvas container. */
  top: number;
  /** Disables the position transition when the viewer prefers reduced motion. */
  reducedMotion: boolean;
}>();
</script>

<template>
  <div
    :class="['remote-cursor', role === 'owner' ? 'remote-cursor--owner' : 'remote-cursor--editor', { 'remote-cursor--static': reducedMotion }]"
    :style="{ transform: `translate(${left}px, ${top}px)` }"
    aria-hidden="true"
  >
    <FeatherIcon name="mouse-pointer" size="16" />
    <span class="remote-cursor-label">{{ email }}</span>
  </div>
</template>

<style scoped>
.remote-cursor {
  align-items: center;
  display: flex;
  gap: 0.3rem;
  left: 0;
  pointer-events: none;
  position: absolute;
  top: 0;
  transition: transform 120ms linear;
  z-index: 5;
}
.remote-cursor--static {
  transition: none;
}
.remote-cursor--owner {
  color: rgb(var(--v-theme-primary));
}
.remote-cursor--editor {
  color: rgb(var(--v-theme-secondary));
}
.remote-cursor-label {
  background: rgb(var(--v-theme-surface));
  border-radius: 0.25rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  font-size: 0.7rem;
  padding: 0.05rem 0.35rem;
  white-space: nowrap;
}
</style>
