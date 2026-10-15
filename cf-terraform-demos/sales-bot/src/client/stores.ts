import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { Role } from '../worker/domain/role';

/**
 * Browser representation of the verified server identity.
 */
interface MeResponse {
  /**
   * Verified Access email.
   */
  email: string;
  /**
   * Server-resolved role.
   */
  role: Role;
}

/**
 * Manage the identity data displayed by the authenticated shell.
 *
 * @returns Reactive identity state and its one-shot loader.
 */
export function useIdentity(): {
  email: Ref<string>;
  error: Ref<string>;
  loading: Ref<boolean>;
  role: Ref<Role>;
  managementVisible: ComputedRef<boolean>;
  load: () => Promise<void>;
} {
  const email = ref('');
  const role = ref<Role>('salesperson');
  const error = ref('');
  const loading = ref(false);
  const managementVisible = computed(
    () => role.value === 'pm' || role.value === 'overseer' || role.value === 'administrator'
  );

  /**
   * Fetch the server-derived identity without trusting browser-controlled role data.
   */
  async function load(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      const response = await fetch('/api/me');
      if (!response.ok) throw new Error('Your identity could not be verified.');
      const body = (await response.json()) as MeResponse;
      email.value = body.email;
      role.value = body.role;
    } catch (reason: unknown) {
      error.value =
        reason instanceof Error ? reason.message : 'Your identity could not be verified.';
    } finally {
      loading.value = false;
    }
  }

  return { email, error, loading, role, managementVisible, load };
}
