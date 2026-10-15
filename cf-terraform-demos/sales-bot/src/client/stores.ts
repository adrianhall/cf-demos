import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { DocumentationSource } from '../worker/domain/documentation';
import type { Faq } from '../worker/domain/faq';
import type { FaqIndexJob } from '../worker/domain/index-job';
import type { Product } from '../worker/domain/product';
import type { Role } from '../worker/domain/role';
import { requestEmpty, requestJson } from './api';

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
 * Fields the FAQ editor submits.
 */
export interface FaqDraft {
  /**
   * Question as a salesperson would ask it.
   */
  question: string;
  /**
   * Approved answer text.
   */
  answer: string;
  /**
   * Owning product slug, or `null` for a cross-product entry.
   */
  productId: string | null;
  /**
   * Audience classification.
   */
  audience: Faq['audience'];
  /**
   * Explicit expiry as an ISO instant, `null` to remove the expiry, or omitted to accept the
   * server's 90-day default. The three cases are genuinely different, which is why this is an
   * optional property holding a nullable value rather than merely nullable.
   */
  expiresAt?: string | null;
}

/**
 * Reactive identity state and its loader.
 */
export interface IdentityStore {
  /**
   * Verified Access email, empty before the first successful load.
   */
  email: Ref<string>;
  /**
   * User-safe failure message, empty when the last load succeeded.
   */
  error: Ref<string>;
  /**
   * Whether an identity request is in flight.
   */
  loading: Ref<boolean>;
  /**
   * Server-resolved role.
   */
  role: Ref<Role>;
  /**
   * Whether the management navigation should be offered.
   */
  managementVisible: ComputedRef<boolean>;
  /**
   * Whether the administrator navigation should be offered.
   */
  adminVisible: ComputedRef<boolean>;
  /**
   * Fetch the server-derived identity.
   *
   * @returns A promise fulfilled once the state reflects the outcome.
   */
  load: () => Promise<void>;
}

/**
 * Manage the identity data displayed by the authenticated shell.
 *
 * What this store exposes is a rendering hint, not an authorization decision. Hiding a link stops a
 * reader stumbling into a page they cannot use; it does not protect the endpoint behind it, which
 * re-checks the actor server-side on every call.
 *
 * @returns Reactive identity state and its one-shot loader.
 */
export function useIdentity(): IdentityStore {
  const email = ref('');
  const role = ref<Role>('salesperson');
  const error = ref('');
  const loading = ref(false);
  const managementVisible = computed(
    () => role.value === 'pm' || role.value === 'overseer' || role.value === 'administrator'
  );
  const adminVisible = computed(() => role.value === 'administrator');

  /**
   * Fetch the server-derived identity without trusting browser-controlled role data.
   *
   * @returns A promise fulfilled once `email`, `role`, and `error` reflect the outcome. A failure
   *   is recorded rather than thrown, because the shell is still usable while the identity
   *   indicator is unavailable.
   */
  async function load(): Promise<void> {
    loading.value = true;
    error.value = '';
    try {
      const body = await requestJson<MeResponse>('/api/me');
      email.value = body.email;
      role.value = body.role;
    } catch (reason: unknown) {
      error.value =
        reason instanceof Error ? reason.message : 'Your identity could not be verified.';
    } finally {
      loading.value = false;
    }
  }

  return { email, error, loading, role, managementVisible, adminVisible, load };
}

/**
 * Reactive knowledge-base state and its actions.
 */
export interface KnowledgeStore {
  /**
   * FAQs currently loaded.
   */
  faqs: Ref<Faq[]>;
  /**
   * Products available in the editor's selector.
   */
  products: Ref<Product[]>;
  /**
   * User-safe failure message, empty when the last action succeeded.
   */
  error: Ref<string>;
  /**
   * Status message announced to assistive technology after a successful action.
   */
  status: Ref<string>;
  /**
   * Whether a request is in flight.
   */
  loading: Ref<boolean>;
  /**
   * Load FAQs and products.
   *
   * @param manage Load the manageable set, including archived and expired revisions.
   * @returns A promise fulfilled once the state reflects the outcome.
   */
  load: (manage: boolean) => Promise<void>;
  /**
   * Publish a new FAQ and reload the list.
   *
   * @param draft Editor fields.
   * @returns A promise fulfilled once the state reflects the outcome.
   */
  publish: (draft: FaqDraft) => Promise<void>;
  /**
   * Publish a new revision of an existing FAQ and reload the list.
   *
   * @param id FAQ identifier.
   * @param changes Fields to change.
   * @returns A promise fulfilled once the state reflects the outcome.
   */
  revise: (id: string, changes: Partial<FaqDraft>) => Promise<void>;
  /**
   * Archive an FAQ and reload the list.
   *
   * @param id FAQ identifier.
   * @returns A promise fulfilled once the state reflects the outcome.
   */
  archive: (id: string) => Promise<void>;
}

/**
 * Manage the FAQ knowledge base from the browser.
 *
 * Every action reloads from the server rather than patching local state from the response. The
 * server decides the revision number, the expiry default, and whether an edit is permitted at all,
 * so a locally reconstructed list would show what the browser guessed rather than what was stored —
 * and in a knowledge base, showing a stale audience or expiry is the one thing worth avoiding.
 *
 * @returns Reactive knowledge-base state and its actions.
 */
export function useKnowledge(): KnowledgeStore {
  const faqs = ref<Faq[]>([]);
  const products = ref<Product[]>([]);
  const error = ref('');
  const status = ref('');
  const loading = ref(false);
  let manageScope = false;

  /**
   * Run an action, recording a user-safe failure instead of throwing.
   *
   * @param action Work to perform.
   * @param fallback Message shown when the failure carries nothing displayable.
   * @param success Message announced when the action succeeds, or empty for none.
   * @returns A promise fulfilled once `error` and `status` reflect the outcome.
   */
  async function run(
    action: () => Promise<void>,
    fallback: string,
    success: string
  ): Promise<void> {
    loading.value = true;
    error.value = '';
    status.value = '';
    try {
      await action();
      status.value = success;
    } catch (reason: unknown) {
      error.value = reason instanceof Error ? reason.message : fallback;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Fetch FAQs and products for the current scope.
   *
   * @returns A promise fulfilled once both lists are replaced.
   * @throws {Error} When either request fails; the caller records it.
   */
  async function fetchAll(): Promise<void> {
    const [faqResponse, productResponse] = await Promise.all([
      requestJson<{ faqs: Faq[] }>(`/api/faqs${manageScope ? '?scope=manage' : ''}`),
      requestJson<{ products: Product[] }>('/api/products')
    ]);
    faqs.value = faqResponse.faqs;
    products.value = productResponse.products;
  }

  return {
    faqs,
    products,
    error,
    status,
    loading,
    load: async (manage: boolean) => {
      manageScope = manage;
      await run(fetchAll, 'The knowledge base could not be loaded.', '');
    },
    publish: async (draft: FaqDraft) =>
      run(
        async () => {
          await requestJson('/api/faqs', { method: 'POST', body: draft });
          await fetchAll();
        },
        'The FAQ could not be published.',
        'FAQ published.'
      ),
    revise: async (id: string, changes: Partial<FaqDraft>) =>
      run(
        async () => {
          await requestJson(`/api/faqs/${id}`, { method: 'PATCH', body: changes });
          await fetchAll();
        },
        'The FAQ could not be updated.',
        'FAQ updated.'
      ),
    archive: async (id: string) =>
      run(
        async () => {
          await requestEmpty(`/api/faqs/${id}`, 'DELETE');
          await fetchAll();
        },
        'The FAQ could not be archived.',
        'FAQ archived.'
      )
  };
}

/**
 * Counts of index jobs by state, used by the freshness summary.
 */
export interface FreshnessCounts {
  /**
   * Jobs waiting to run.
   */
  pending: number;
  /**
   * Jobs that completed successfully.
   */
  indexed: number;
  /**
   * Jobs that exhausted their attempts.
   */
  failed: number;
}

/**
 * Reactive administrator state and its actions.
 */
export interface AdminStore {
  /**
   * Approved documentation pages and their indexing state.
   */
  sources: Ref<DocumentationSource[]>;
  /**
   * Recent index jobs.
   */
  jobs: Ref<FaqIndexJob[]>;
  /**
   * Job counts by state.
   */
  counts: ComputedRef<FreshnessCounts>;
  /**
   * User-safe failure message, empty when the last action succeeded.
   */
  error: Ref<string>;
  /**
   * Status message announced to assistive technology after a successful action.
   */
  status: Ref<string>;
  /**
   * Whether a request is in flight.
   */
  loading: Ref<boolean>;
  /**
   * Load the documentation sources and index jobs.
   *
   * @returns A promise fulfilled once the state reflects the outcome.
   */
  load: () => Promise<void>;
  /**
   * Import the committed documentation manifest and reload.
   *
   * @returns A promise fulfilled once the state reflects the outcome.
   */
  importDocumentation: () => Promise<void>;
  /**
   * Run the pending index jobs once and reload.
   *
   * @returns A promise fulfilled once the state reflects the outcome.
   */
  runIndexJobs: () => Promise<void>;
}

/**
 * Manage the administrator freshness view.
 *
 * @returns Reactive administrator state and its actions.
 */
export function useAdmin(): AdminStore {
  const sources = ref<DocumentationSource[]>([]);
  const jobs = ref<FaqIndexJob[]>([]);
  const error = ref('');
  const status = ref('');
  const loading = ref(false);

  const counts = computed<FreshnessCounts>(() => ({
    pending: jobs.value.filter((job) => job.status === 'pending').length,
    indexed: jobs.value.filter((job) => job.status === 'indexed').length,
    failed: jobs.value.filter((job) => job.status === 'failed').length
  }));

  /**
   * Fetch both administrator lists.
   *
   * @returns A promise fulfilled once both lists are replaced.
   * @throws {Error} When either request fails; the caller records it.
   */
  async function fetchAll(): Promise<void> {
    const [sourceResponse, jobResponse] = await Promise.all([
      requestJson<{ sources: DocumentationSource[] }>('/api/admin/documentation'),
      requestJson<{ jobs: FaqIndexJob[] }>('/api/admin/index-jobs')
    ]);
    sources.value = sourceResponse.sources;
    jobs.value = jobResponse.jobs;
  }

  /**
   * Run an action, recording a user-safe failure instead of throwing.
   *
   * The action returns its own announcement rather than being given one, because the useful message
   * for an import or an index run is the counts it produced, which are not known until it
   * finishes.
   *
   * @param action Work to perform, resolving to the message to announce.
   * @param fallback Message shown when the failure carries nothing displayable.
   * @returns A promise fulfilled once `error` and `status` reflect the outcome.
   */
  async function run(action: () => Promise<string>, fallback: string): Promise<void> {
    loading.value = true;
    error.value = '';
    status.value = '';
    try {
      status.value = await action();
    } catch (reason: unknown) {
      error.value = reason instanceof Error ? reason.message : fallback;
    } finally {
      loading.value = false;
    }
  }

  return {
    sources,
    jobs,
    counts,
    error,
    status,
    loading,
    load: async () =>
      run(async () => {
        await fetchAll();
        return '';
      }, 'The administrator view could not be loaded.'),
    importDocumentation: async () =>
      run(async () => {
        const summary = await requestJson<{ imported: number; unchanged: number }>(
          '/api/admin/documentation/import',
          { method: 'POST', body: {} }
        );
        await fetchAll();
        return `Imported ${summary.imported} pages; ${summary.unchanged} unchanged.`;
      }, 'The documentation manifest could not be imported.'),
    runIndexJobs: async () =>
      run(async () => {
        const summary = await requestJson<{ indexed: number; retrying: number; failed: number }>(
          '/api/admin/index-jobs/run',
          { method: 'POST', body: {} }
        );
        await fetchAll();
        return `Indexed ${summary.indexed}; retrying ${summary.retrying}; failed ${summary.failed}.`;
      }, 'The index jobs could not be run.')
  };
}
