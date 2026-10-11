<script setup lang="ts">
/**
 * Presents the loading, error, permission-denied, and empty states of one resource, and renders the
 * default slot once content is available.
 *
 * Built from Vuetify primitives (`VSkeletonLoader`, `VAlert`, `VEmptyState`, `VBtn`); it exists
 * only so every view presents these states identically. It takes state and emits intent; it never
 * calls the API.
 *
 * @fires retry When the user asks to retry a failed load.
 */
import { computed } from 'vue';
import type { ResourceState } from '../composables/useResource.ts';
import type { ApiError } from '../services/api-client.ts';

const props = defineProps<{
  /**
   * Current loading state.
   */
  state: ResourceState;
  /**
   * The failure, when `state` is `error`.
   */
  error: ApiError | null;
  /**
   * Whether the loaded content is empty.
   */
  empty?: boolean;
  /**
   * Heading shown for the empty state.
   */
  emptyTitle?: string;
  /**
   * Text shown for the empty state.
   */
  emptyText?: string;
  /**
   * Skeleton type while loading.
   */
  skeleton?: string;
  /**
   * Whether content has loaded at least once (keeps it visible during a refresh).
   */
  hasData?: boolean;
}>();

const emit = defineEmits<{
  /**
   * The user asked to retry.
   */
  retry: [];
}>();

const errorTitle = computed(() => {
  switch (props.error?.kind) {
    case 'forbidden':
      return 'You do not have access';
    case 'unauthenticated':
      return 'Please sign in again';
    case 'not-found':
      return 'Not found';
    case 'unavailable':
    case 'network':
      return 'Temporarily unavailable';
    default:
      return 'Something went wrong';
  }
});

const retryable = computed(
  () =>
    props.error?.kind !== 'forbidden'
    && props.error?.kind !== 'not-found'
    && props.error?.kind !== 'unauthenticated'
);

/**
 * Reload the whole page, so Cloudflare Access can run its sign-in flow.
 */
function reloadPage(): void {
  window.location.reload();
}
</script>

<template>
  <div :aria-busy="state === 'loading'">
    <v-skeleton-loader
      v-if="state === 'loading' && !hasData"
      :type="skeleton ?? 'list-item-two-line@3'"
    />
    <v-alert
      v-else-if="state === 'error'"
      :type="error?.kind === 'forbidden' ? 'warning' : 'error'"
      variant="tonal"
      :title="errorTitle"
      role="alert"
    >
      <p>{{ error?.message }}</p>
      <p v-if="error?.requestId" class="text-caption">Reference: {{ error.requestId }}</p>
      <template v-if="retryable" #append>
        <v-btn variant="text" @click="emit('retry')">Retry</v-btn>
      </template>
      <template v-else-if="error?.kind === 'unauthenticated'" #append>
        <v-btn variant="text" @click="reloadPage">Sign in</v-btn>
      </template>
    </v-alert>
    <v-empty-state
      v-else-if="state === 'success' && empty"
      :headline="emptyTitle ?? 'Nothing here yet'"
      :text="emptyText"
    >
      <template #actions><slot name="empty-actions" /></template>
    </v-empty-state>
    <slot v-else-if="state === 'success' || hasData" />
  </div>
</template>
