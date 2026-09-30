import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { EntityTypeId } from '../domain/entity-types';

/**
 * One step in the path a user actually took.
 */
export interface TrailStep {
  /**
   * Entity type at this step.
   */
  typeId: EntityTypeId;
  /**
   * Entity identifier, or `null` for the step representing "the collection itself" — the entry a
   * user creates by choosing a type in the navigation column before opening anything.
   */
  entityId: string | null;
  /**
   * Label to show. Held here rather than looked up so a breadcrumb never blanks while the entity it
   * names is refetched, and so the trail survives a reload from the URL alone.
   */
  label: string;
}

/**
 * Maximum steps rendered before the trail is truncated in the middle.
 *
 * Small enough that the breadcrumb stays on one line at ordinary widths, large enough that a
 * typical exploration is shown in full.
 */
export const MAX_VISIBLE_TRAIL_STEPS = 5;

/**
 * Where the user is, and how they got there.
 *
 * Kept apart from the catalog store because it is a different kind of state: the catalog holds the
 * dataset, which is shared and cacheable, while this holds one person's position in it, which is
 * neither. Splitting them means navigation never invalidates data and a data refresh never moves
 * the user.
 *
 * @returns The explorer store.
 */
export const useExplorerStore = defineStore('explorer', () => {
  const trail = ref<TrailStep[]>([]);
  const filters = ref<Partial<Record<EntityTypeId, string>>>({});

  /**
   * The step the user is currently looking at.
   */
  const currentStep = computed<TrailStep | null>(() => trail.value.at(-1) ?? null);

  /**
   * Type currently selected in the navigation column, or `null` at the empty state.
   */
  const currentTypeId = computed<EntityTypeId | null>(() => currentStep.value?.typeId ?? null);

  /**
   * Entity currently open in the detail column, or `null` when only a collection is selected.
   */
  const currentEntityId = computed<string | null>(() => currentStep.value?.entityId ?? null);

  /**
   * Begin a new line of enquiry at a collection.
   *
   * Resets the trail rather than extending it, because choosing a type in the navigation column is
   * a fresh start rather than a continuation (UISPEC §8). The filter for the newly selected type is
   * cleared for the same reason: it belongs to the list it filters (UISPEC §5.2).
   *
   * @param typeId Collection to select.
   * @param label Collection label for the first breadcrumb segment.
   */
  function selectCollection(typeId: EntityTypeId, label: string): void {
    trail.value = [{ typeId, entityId: null, label }];
    filters.value = { ...filters.value, [typeId]: '' };
  }

  /**
   * Open an entity, extending or truncating the trail as appropriate.
   *
   * This is the single rule UISPEC §8 asks for, and every click routes through it: a relation panel
   * entry, a global search result, and a collection row all land here, so none of them can develop
   * its own navigation behaviour.
   *
   * Three cases, and the second and third are what keep the trail honest:
   *
   * 1. **A new entity** extends the trail.
   * 2. **An entity already in the trail** truncates back to it, rather than appending a duplicate and
   *    implying a longer journey than was taken. Returning to Tatooine after wandering away
   *    shortens the path; it does not lengthen it.
   * 3. **Re-selecting the current entity** changes nothing, so a redundant click cannot grow the
   *    trail.
   *
   * @param typeId Type of the entity being opened.
   * @param entityId Identifier of the entity being opened.
   * @param label Display name for the breadcrumb segment.
   */
  function selectEntity(typeId: EntityTypeId, entityId: string, label: string): void {
    const existingIndex = trail.value.findIndex(
      (step) => step.typeId === typeId && step.entityId === entityId
    );

    if (existingIndex >= 0) {
      trail.value = trail.value.slice(0, existingIndex + 1);
      return;
    }

    trail.value = [...trail.value, { typeId, entityId, label }];
  }

  /**
   * Return to an earlier step, discarding everything after it.
   *
   * @param index Position in the trail to return to. Out-of-range values are ignored rather than
   *   throwing, since a stale click on a breadcrumb that has since been truncated is ordinary.
   */
  function truncateTo(index: number): void {
    if (index < 0 || index >= trail.value.length) {
      return;
    }
    trail.value = trail.value.slice(0, index + 1);
  }

  /**
   * Replace the whole trail, used when restoring from a URL on load.
   *
   * @param steps Steps to restore, in order.
   */
  function restoreTrail(steps: readonly TrailStep[]): void {
    trail.value = [...steps];
  }

  /**
   * Correct a step's label once the entity it names has loaded.
   *
   * A trail restored from a URL knows identifiers but not names, so its segments start as
   * placeholders. Rewriting them in place — rather than rebuilding the trail — means the breadcrumb
   * fills in as data arrives without the user's position shifting underneath them.
   *
   * @param typeId Type of the entity whose label is now known.
   * @param entityId Identifier of that entity.
   * @param label Correct display name.
   */
  function labelStep(typeId: EntityTypeId, entityId: string, label: string): void {
    const index = trail.value.findIndex(
      (step) => step.typeId === typeId && step.entityId === entityId
    );
    const step = trail.value[index];

    // Label hydration watches this same trail. Replacing it when the authoritative label is already
    // present would retrigger that watcher, which would load the cached entity, call this function
    // again, replace the trail again, and spin forever in resolved promises. Vue has no synchronous
    // recursive update to report in that case, so the symptom is a frozen interface rather than a
    // console error. A no-op must preserve the array identity as well as its contents.
    if (step === undefined || step.label === label) {
      return;
    }

    const updated = [...trail.value];
    updated[index] = { ...step, label };
    trail.value = updated;
  }

  /**
   * Current filter text for one collection.
   *
   * @returns A function from type identifier to its filter text, empty when unset.
   */
  const filterFor = computed(
    () =>
      (typeId: EntityTypeId): string =>
        filters.value[typeId] ?? ''
  );

  /**
   * Set the filter text for one collection.
   *
   * Filters are stored per type, which is what makes UISPEC §5.2's two rules fall out naturally:
   * the filter persists while the user moves between entities of the same type, and a different
   * type simply has a different entry.
   *
   * @param typeId Collection the filter belongs to.
   * @param value Filter text as typed.
   */
  function setFilter(typeId: EntityTypeId, value: string): void {
    filters.value = { ...filters.value, [typeId]: value };
  }

  return {
    trail,
    currentStep,
    currentTypeId,
    currentEntityId,
    filterFor,
    selectCollection,
    selectEntity,
    truncateTo,
    restoreTrail,
    labelStep,
    setFilter
  };
});
