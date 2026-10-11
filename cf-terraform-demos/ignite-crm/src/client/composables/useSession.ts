/**
 * @file Module-scoped identity and configuration cache shared by the shell, navigation, and views.
 *   Loaded once per page load. Capability hints decide which controls are shown; the server still
 *   decides every request, and views handle a 403 regardless.
 */

import { computed, type ComputedRef, ref, type Ref, shallowRef } from 'vue';
import type { DisplayConfiguration } from '../../shared/api/configuration.ts';
import type { Session } from '../../shared/api/session.ts';
import type { Permission } from '../../shared/permissions.ts';
import { api, type ApiClient, ApiError } from '../services/api-client.ts';

/**
 * Loading state of the session.
 */
export type SessionState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Shared session state.
 */
const session: Ref<Session | null> = shallowRef(null);
const configuration: Ref<DisplayConfiguration | null> = shallowRef(null);
const state: Ref<SessionState> = ref('idle');
const error: Ref<ApiError | null> = shallowRef(null);
let pending: Promise<void> | null = null;

/**
 * What {@link useSession} returns.
 */
export interface UseSession {
  /**
   * The session, once loaded.
   */
  readonly session: ComputedRef<Session | null>;
  /**
   * The display configuration, once loaded.
   */
  readonly configuration: ComputedRef<DisplayConfiguration | null>;
  /**
   * Loading state.
   */
  readonly state: ComputedRef<SessionState>;
  /**
   * The load failure, if any.
   */
  readonly error: ComputedRef<ApiError | null>;
  /**
   * Comma-separated role labels.
   */
  readonly roleLabel: ComputedRef<string>;
  /**
   * Whether the session carries a capability hint.
   *
   * @param permission The permission.
   * @returns Whether the user's roles grant it.
   */
  can(permission: Permission): boolean;
  /**
   * Load the session and configuration (once; concurrent callers share the request).
   *
   * @param client API client (injectable for tests).
   * @returns Once loaded or failed.
   */
  load(client?: ApiClient): Promise<void>;
  /**
   * Discard the cached session and load it again, for example after an owner changes their own
   * roles. Capability hints are otherwise loaded once per page load; the server never relies on
   * them.
   *
   * @param client API client (injectable for tests).
   * @returns Once reloaded or failed.
   */
  reload(client?: ApiClient): Promise<void>;
}

/**
 * Access the shared session.
 *
 * @returns The session API.
 */
export function useSession(): UseSession {
  const shared: UseSession = {
    session: computed(() => session.value),
    configuration: computed(() => configuration.value),
    state: computed(() => state.value),
    error: computed(() => error.value),
    roleLabel: computed(() => session.value?.roles.map((role) => role.label).join(', ') ?? ''),
    can: (permission) => session.value?.permissions.includes(permission) ?? false,
    load: (client = api) => {
      if (state.value === 'ready') {
        return Promise.resolve();
      }
      pending ??= (async () => {
        state.value = 'loading';
        error.value = null;
        try {
          const [loadedSession, loadedConfiguration] = await Promise.all([
            client.session(),
            client.configuration()
          ]);
          session.value = loadedSession;
          configuration.value = loadedConfiguration;
          state.value = 'ready';
        } catch (caught) {
          error.value =
            caught instanceof ApiError
              ? caught
              : new ApiError('server', 'Could not load your session.', 0);
          state.value = 'error';
        } finally {
          pending = null;
        }
      })();
      return pending;
    },
    reload: (client = api) => {
      if (state.value === 'ready') {
        state.value = 'idle';
      }
      return shared.load(client);
    }
  };
  return shared;
}

/**
 * Reset the cache (tests only).
 */
export function resetSession(): void {
  session.value = null;
  configuration.value = null;
  state.value = 'idle';
  error.value = null;
  pending = null;
}
