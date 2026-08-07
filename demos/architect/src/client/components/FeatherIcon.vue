<script setup lang="ts">
import { icons } from "feather-icons";
import { computed } from "vue";

/** Curated Feather icon names actually used by this demo's UI. */
export type FeatherIconName =
  | "check"
  | "copy"
  | "corner-down-right"
  | "edit-2"
  | "folder"
  | "git-commit"
  | "grid"
  | "log-out"
  | "plus"
  | "save"
  | "search"
  | "trash-2"
  | "user"
  | "user-plus"
  | "users"
  | "x";

const props = withDefaults(
  defineProps<{
    /** Which curated Feather icon to render. */
    name: FeatherIconName;
    /** Square pixel size of the rendered icon. */
    size?: number;
  }>(),
  { size: 18 },
);

/** Feather's own SVG markup for the requested icon, sized per `size`. */
const markup = computed(() =>
  icons[props.name].toSvg({ height: props.size, width: props.size }),
);
</script>

<template>
  <!--
    Feather's own SVG markup for a fixed, developer-selected icon name (never user input), so
    injecting it is not an XSS risk despite using v-html.
  -->
  <span aria-hidden="true" class="feather-icon" v-html="markup" />
</template>

<style scoped>
.feather-icon {
  align-items: center;
  display: inline-flex;
  line-height: 0;
}
</style>
