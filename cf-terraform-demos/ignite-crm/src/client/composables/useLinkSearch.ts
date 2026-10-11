/**
 * @file Search state for a {@link RecordLinkChooser}: results for the latest type and text, a
 *   loading flag, and protection against out-of-order responses.
 */

import { type Ref, ref, shallowRef } from 'vue';
import type { NoteLinkType } from '../../shared/api/notes.ts';
import { ApiError } from '../services/api-client.ts';
import { searchLinkOptions } from '../services/link-search.ts';
import type { LinkOption } from '../services/note-draft.ts';

/**
 * Link search state.
 */
export interface UseLinkSearch {
  /**
   * Results of the most recent search.
   */
  readonly results: Ref<LinkOption[]>;
  /**
   * Whether a search is in flight.
   */
  readonly searching: Ref<boolean>;
  /**
   * The latest search failure. An outage is not an empty result.
   */
  readonly error: Ref<ApiError | null>;
  /**
   * Run a search; the chooser's `search` event handler.
   *
   * @param type Record type.
   * @param text Search text.
   * @returns Once the results (or an empty list on failure) are in place.
   */
  search(type: NoteLinkType, text: string): Promise<void>;
}

/**
 * Create link search state.
 *
 * @returns The state and its search function. A failed search clears stale results and exposes an
 *   error so the chooser does not claim there were no matches during an outage.
 */
export function useLinkSearch(): UseLinkSearch {
  const results = shallowRef<LinkOption[]>([]);
  const searching = ref(false);
  const error = shallowRef<ApiError | null>(null);
  let generation = 0;

  /**
   * @inheritdoc
   */
  async function search(type: NoteLinkType, text: string): Promise<void> {
    const current = ++generation;
    searching.value = true;
    error.value = null;
    results.value = [];
    try {
      const found = await searchLinkOptions(type, text);
      if (current === generation) {
        results.value = found;
      }
    } catch (caught) {
      if (current === generation) {
        error.value =
          caught instanceof ApiError
            ? caught
            : new ApiError('server', 'Could not search records.', 0);
      }
    } finally {
      if (current === generation) {
        searching.value = false;
      }
    }
  }

  return { results, searching, error, search };
}
