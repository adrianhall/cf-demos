/**
 * @file The breadcrumb trail: what it is, and the four operations that keep it honest. Because the
 *   explorer's columns replace rather than accumulate, the trail is the only thing preserving the
 *   sense of a journey (UISPEC §7). It must therefore describe the path the user **actually took**,
 *   which is a stronger requirement than "a list of things visited" and is what every function here
 *   exists to enforce. These are pure functions over a readonly array rather than methods on a
 *   store. The trail lives in the URL — `src/ui/state/trail-url.ts` encodes and decodes it — so
 *   React holds it as ordinary state derived from the route, and the rules that transform it are
 *   testable without rendering.
 */

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
 * Placeholder label for a step restored from a URL, before its record has loaded.
 *
 * A URL carries identifiers but not display names, so a restored trail necessarily starts with
 * placeholders. {@link labelStep} replaces them as records arrive.
 */
export const PLACEHOLDER_LABEL = 'Loading…';

/**
 * Maximum steps rendered before the trail is truncated in the middle.
 *
 * Small enough that the breadcrumb stays on one line at ordinary widths, large enough that a
 * typical exploration is shown in full.
 */
export const MAX_VISIBLE_TRAIL_STEPS = 5;

/**
 * Begin a new line of enquiry at a collection.
 *
 * Returns a one-step trail rather than extending the old one, because choosing a type in the
 * navigation column is a fresh start rather than a continuation (UISPEC §8).
 *
 * @param typeId Collection being selected.
 * @param label Collection label for the first breadcrumb segment.
 * @returns The new trail.
 */
export function collectionTrail(typeId: EntityTypeId, label: string): TrailStep[] {
  return [{ typeId, entityId: null, label }];
}

/**
 * Open an entity, extending or truncating the trail as appropriate.
 *
 * This is the single rule UISPEC §8 asks for, and every click routes through it: a relation panel
 * entry, a global search result, and a collection row all land here, so none of them can develop
 * its own navigation behaviour.
 *
 * Three cases, and the second is what keeps the trail honest:
 *
 * 1. **A new entity** extends the trail.
 * 2. **An entity already in the trail** truncates back to it, rather than appending a duplicate and
 *    implying a longer journey than was taken. Returning to Tatooine after wandering away shortens
 *    the path; it does not lengthen it. Re-selecting the entity the user is already looking at is
 *    the same case and correctly changes nothing.
 * 3. **No trail yet** — the entity's own collection is seeded as the first step, so a breadcrumb
 *    always begins somewhere a user can click back to.
 *
 * @param trail Current trail.
 * @param typeId Type of the entity being opened.
 * @param entityId Identifier of the entity being opened.
 * @param label Display name for the breadcrumb segment.
 * @param collectionLabel Plural label used when the trail has to be seeded with a collection step.
 * @returns The new trail. The input array is never modified.
 */
export function selectEntity(
  trail: readonly TrailStep[],
  typeId: EntityTypeId,
  entityId: string,
  label: string,
  collectionLabel: string
): TrailStep[] {
  const existing = trail.findIndex((step) => step.typeId === typeId && step.entityId === entityId);
  if (existing >= 0) {
    return trail.slice(0, existing + 1);
  }

  const base = trail.length > 0 ? trail : collectionTrail(typeId, collectionLabel);
  return [...base, { typeId, entityId, label }];
}

/**
 * Return to an earlier step, discarding everything after it.
 *
 * @param trail Current trail.
 * @param index Position to return to. Out-of-range values return the trail unchanged rather than
 *   throwing, since a stale click on a breadcrumb that has since been truncated is ordinary.
 * @returns The truncated trail, or the original array when the index names no step.
 */
export function truncateTrail(trail: readonly TrailStep[], index: number): readonly TrailStep[] {
  if (index < 0 || index >= trail.length) {
    return trail;
  }
  return trail.slice(0, index + 1);
}

/**
 * Correct a step's label once the entity it names has loaded.
 *
 * A trail restored from a URL knows identifiers but not names, so its segments start as
 * placeholders. Rewriting them in place — rather than rebuilding the trail — means the breadcrumb
 * fills in as data arrives without the user's position shifting underneath them.
 *
 * **Returning the original array for a no-op is load-bearing, not an optimisation.** The effect
 * that hydrates labels depends on the trail, so replacing the array when the label is already
 * correct would retrigger that effect, which would read the cached entity, call this function
 * again, replace the array again, and spin forever through resolved promises. React reports no
 * error for that, because each turn is a legitimate asynchronous update; the symptom is a frozen
 * interface. Identity stability is what breaks the cycle.
 *
 * @param trail Current trail.
 * @param typeId Type of the entity whose label is now known.
 * @param entityId Identifier of that entity.
 * @param label Correct display name.
 * @returns A new trail when a label genuinely changed; otherwise the original array unchanged.
 */
export function labelStep(
  trail: readonly TrailStep[],
  typeId: EntityTypeId,
  entityId: string,
  label: string
): readonly TrailStep[] {
  const index = trail.findIndex((step) => step.typeId === typeId && step.entityId === entityId);
  const step = trail[index];
  if (step === undefined || step.label === label) {
    return trail;
  }

  const updated = [...trail];
  updated[index] = { ...step, label };
  return updated;
}

/**
 * One rendered breadcrumb segment: either a step, or the gap standing in for several.
 */
export type TrailSegment =
  | {
      /**
       * A real step the user can click to return to.
       */
      kind: 'step';
      /**
       * Position in the full trail, which is what a click reports back.
       */
      index: number;
      /**
       * The step itself.
       */
      step: TrailStep;
    }
  | {
      /**
       * The middle of a long trail, elided.
       */
      kind: 'ellipsis';
      /**
       * How many steps this gap stands for, so the gap can say so rather than being a bare `…`.
       */
      hidden: number;
    };

/**
 * Prepare a trail for rendering, eliding the middle when it is long.
 *
 * Truncation is from the middle rather than from either end because those are the ends a user
 * reasons about (UISPEC §7): the origin says what line of enquiry this is, and the last few steps
 * say where they are now. The steps in between are the ones they are least likely to want back.
 *
 * @param trail Full trail.
 * @param maxVisible Most steps to show before eliding; defaults to {@link MAX_VISIBLE_TRAIL_STEPS}.
 * @returns Segments in display order. A short trail yields only `step` segments, so the caller
 *   needs no special case for it.
 */
export function visibleTrail(
  trail: readonly TrailStep[],
  maxVisible: number = MAX_VISIBLE_TRAIL_STEPS
): TrailSegment[] {
  const steps = trail.map((step, index): TrailSegment => ({ kind: 'step', index, step }));
  if (steps.length <= maxVisible) {
    return steps;
  }

  // Keep the origin plus the most recent steps; the ellipsis itself occupies one of the slots.
  const tailCount = maxVisible - 2;
  return [
    steps[0]!,
    { kind: 'ellipsis', hidden: steps.length - 1 - tailCount },
    ...steps.slice(steps.length - tailCount)
  ];
}
