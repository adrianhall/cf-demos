/**
 * @file Route-scoped resource loading with a discriminated state and stale-request cancellation.
 */

import { onBeforeUnmount, ref, type Ref, shallowRef } from 'vue';
import { ApiError } from '../services/api-client.ts';

/**
 * Resource loading state.
 */
export type ResourceState = 'idle' | 'loading' | 'success' | 'error';

/**
 * What {@link useResource} returns.
 */
export interface UseResource<T> {
  /**
   * The loaded value; kept during a refresh so content stays visible.
   */
  readonly data: Ref<T | null>;
  /**
   * Loading state.
   */
  readonly state: Ref<ResourceState>;
  /**
   * The failure, when `state` is `error`.
   */
  readonly error: Ref<ApiError | null>;
  /**
   * (Re)load, cancelling any in-flight load.
   *
   * @returns Once settled.
   */
  load(): Promise<void>;
}

/**
 * Manage loading one resource.
 *
 * @param loader Fetches the resource, honouring the abort signal.
 * @returns The resource state and loader.
 */
export function useResource<T>(loader: (signal: AbortSignal) => Promise<T>): UseResource<T> {
  const data = shallowRef<T | null>(null) as Ref<T | null>;
  const state = ref<ResourceState>('idle');
  const error = shallowRef<ApiError | null>(null);
  let controller: AbortController | null = null;

  /**
   * Load, superseding an earlier load.
   *
   * @returns Once settled.
   */
  async function load(): Promise<void> {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    state.value = 'loading';
    error.value = null;
    try {
      const value = await loader(current.signal);
      if (!current.signal.aborted) {
        data.value = value;
        state.value = 'success';
      }
    } catch (caught) {
      if (current.signal.aborted) {
        return;
      }
      error.value =
        caught instanceof ApiError ? caught : new ApiError('server', 'Something went wrong.', 0);
      state.value = 'error';
    }
  }

  onBeforeUnmount(() => controller?.abort());

  return { data, state, error, load };
}
