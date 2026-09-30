/**
 * @file The six object references, declared separately from the fields that use them.
 *
 *   ## Why refs are declared apart from their fields
 *
 *   This schema is cyclic: a film has characters, and a character has films. Whichever type were
 *   defined first would need to name a type that did not exist yet. Pothos solves that with
 *   two-phase definition — create an opaque reference first, then `implement()` its fields later —
 *   and keeping the references in this module is what makes the cycle expressible without circular
 *   imports between the type modules. Each `./<entity>.ts` imports refs from here; none imports
 *   another type module.
 *
 *   ## What `loadableObjectRef` buys
 *
 *   Every reference is _loadable_, meaning a resolver may return an entity's **identifier** instead
 *   of the entity itself and Pothos will fetch it through a request-scoped DataLoader. That is what
 *   makes the single-valued relations cheap: `Person.homeworld` returns `person.homeworldId`, and
 *   however many characters a query touches, their homeworlds are fetched in batches of up to
 *   {@link RELATION_BATCH_SIZE} rather than one at a time. It also means the top-level `film(id:
 *   ...)` style fields need no resolver logic at all — they return the caller's argument and the
 *   loader turns it into an entity, or into `null` if no such row exists.
 */

import type { Film, Person, Planet, Species, Starship, Vehicle } from '../../../domain/entities';
import { RELATION_BATCH_SIZE } from '../../../infrastructure/queries/sql';
import { builder } from '../builder';

/**
 * DataLoader options shared by every loadable reference and relation field.
 *
 * `maxBatchSize` is not a performance tuning knob here but a correctness requirement: D1 rejects a
 * statement binding more than 100 parameters, so a batch larger than this could not be expressed as
 * a single `IN (...)` query. DataLoader splits anything bigger into several batches automatically.
 */
const loaderOptions = { maxBatchSize: RELATION_BATCH_SIZE } as const;

/**
 * Extract the parent key a relation query projected onto each row.
 *
 * Pothos calls this to split one flat batched result back into per-parent lists. The check is
 * defensive rather than decorative: if a relation statement were ever written without its
 * `parent_id` projection, grouping would silently produce empty lists for every parent, and the API
 * would report "this film has no characters" rather than failing. A loud error naming the cause is
 * much easier to diagnose than plausible-looking wrong data.
 *
 * @param entity Row returned by a relation loader, expected to carry `parentId`.
 * @returns The parent identifier to group this row under.
 * @throws {Error} When the row has no string `parentId`, which means the underlying statement
 *   failed to project its parent key.
 */
export function relationParentId(entity: unknown): string {
  if (
    typeof entity !== 'object'
    || entity === null
    || !('parentId' in entity)
    || typeof entity.parentId !== 'string'
  ) {
    throw new Error('A relation query returned a row without its parent_id projection.');
  }

  return entity.parentId;
}

/**
 * Loadable reference for a film.
 */
export const filmType = builder.loadableObjectRef<Film, string>('Film', {
  load: (ids, context) => context.repositories.films.findByIds(ids),
  toKey: (film) => film.id,
  // `sort` lets Pothos match loaded entities back to the identifiers that were requested, which is
  // what allows the repositories to return rows in their natural SQL order and to omit identifiers
  // that matched no row.
  sort: true,
  // An entity loaded by one field is reused by another in the same request. A query selecting both
  // `films` and `person.films` therefore reads each film once, not twice.
  cacheResolved: true,
  loaderOptions
});

/**
 * Loadable reference for a character.
 */
export const personType = builder.loadableObjectRef<Person, string>('Person', {
  load: (ids, context) => context.repositories.people.findByIds(ids),
  toKey: (person) => person.id,
  sort: true,
  cacheResolved: true,
  loaderOptions
});

/**
 * Loadable reference for a planet.
 */
export const planetType = builder.loadableObjectRef<Planet, string>('Planet', {
  load: (ids, context) => context.repositories.planets.findByIds(ids),
  toKey: (planet) => planet.id,
  sort: true,
  cacheResolved: true,
  loaderOptions
});

/**
 * Loadable reference for a species.
 */
export const speciesType = builder.loadableObjectRef<Species, string>('Species', {
  load: (ids, context) => context.repositories.species.findByIds(ids),
  toKey: (species) => species.id,
  sort: true,
  cacheResolved: true,
  loaderOptions
});

/**
 * Loadable reference for a starship.
 */
export const starshipType = builder.loadableObjectRef<Starship, string>('Starship', {
  load: (ids, context) => context.repositories.starships.findByIds(ids),
  toKey: (starship) => starship.id,
  sort: true,
  cacheResolved: true,
  loaderOptions
});

/**
 * Loadable reference for a vehicle.
 */
export const vehicleType = builder.loadableObjectRef<Vehicle, string>('Vehicle', {
  load: (ids, context) => context.repositories.vehicles.findByIds(ids),
  toKey: (vehicle) => vehicle.id,
  sort: true,
  cacheResolved: true,
  loaderOptions
});

/**
 * Options every multi-valued relation field passes to `t.loadableGroup`.
 *
 * `byPath: true` keys the loader by the field's position in the query document as well as by parent
 * identifier. That is required because these fields take a `first` argument: without it, a query
 * selecting `characters(first: 3)` and `characters` on the same film would share one loader, and
 * whichever resolved first would decide the limit for both.
 */
export const relationFieldOptions = {
  byPath: true,
  loaderOptions,
  group: relationParentId
} as const;
