/**
 * @file The `Query` root and the assembled executable schema. The six `import './types/...'`
 *   statements below are side-effecting and load-bearing: each one calls `implement()` on the
 *   matching reference from `./types/refs.ts`. Without them the schema would build with six
 *   declared-but-empty object types and fail at runtime. They are imported here, at the single
 *   place the schema is assembled, rather than from each other — which is what keeps the cyclic
 *   relations free of circular imports between type modules.
 */

import { builder } from './builder';
import './types/film';
import './types/person';
import './types/planet';
import './types/species';
import './types/starship';
import './types/vehicle';
import {
  filmType,
  personType,
  planetType,
  speciesType,
  starshipType,
  vehicleType
} from './types/refs';

/**
 * The query root: a list field and a by-identifier field for each of the six entities.
 *
 * The list fields read straight through their repository, since "every film" is a single unbatched
 * statement.
 *
 * The singular fields look unusual — each resolver returns the `id` argument it was given rather
 * than an entity. That is the loadable reference at work (see `./types/refs.ts`): returning a key
 * hands the lookup to the request's DataLoader, so `{ a: film(id: "…") b: film(id: "…") }` costs
 * one statement rather than two, and an identifier matching no row resolves to `null` instead of
 * raising. There is deliberately no hand-written "fetch one entity" path anywhere in this schema.
 *
 * `speciesList` breaks the naming symmetry because "species" is its own plural, so the singular
 * field already owns the obvious name and GraphQL field names must be unique.
 */
builder.queryType({
  description: 'Read-only access to the Star Wars dataset.',
  fields: (t) => ({
    films: t.field({
      type: [filmType],
      description: 'Every film, in saga order.',
      resolve: (_root, _args, context) => context.repositories.films.list()
    }),
    film: t.field({
      type: filmType,
      nullable: true,
      description: 'One film by identifier, or null when no such film exists.',
      args: { id: t.arg.id({ required: true, description: "The film's identifier." }) },
      resolve: (_root, { id }) => id
    }),

    people: t.field({
      type: [personType],
      description: 'Every character, ordered by name.',
      resolve: (_root, _args, context) => context.repositories.people.list()
    }),
    person: t.field({
      type: personType,
      nullable: true,
      description: 'One character by identifier, or null when no such character exists.',
      args: { id: t.arg.id({ required: true, description: "The character's identifier." }) },
      resolve: (_root, { id }) => id
    }),

    planets: t.field({
      type: [planetType],
      description: 'Every planet, ordered by name.',
      resolve: (_root, _args, context) => context.repositories.planets.list()
    }),
    planet: t.field({
      type: planetType,
      nullable: true,
      description: 'One planet by identifier, or null when no such planet exists.',
      args: { id: t.arg.id({ required: true, description: "The planet's identifier." }) },
      resolve: (_root, { id }) => id
    }),

    speciesList: t.field({
      type: [speciesType],
      description: 'Every species, ordered by name.',
      resolve: (_root, _args, context) => context.repositories.species.list()
    }),
    species: t.field({
      type: speciesType,
      nullable: true,
      description: 'One species by identifier, or null when no such species exists.',
      args: { id: t.arg.id({ required: true, description: "The species' identifier." }) },
      resolve: (_root, { id }) => id
    }),

    starships: t.field({
      type: [starshipType],
      description: 'Every starship, ordered by name.',
      resolve: (_root, _args, context) => context.repositories.starships.list()
    }),
    starship: t.field({
      type: starshipType,
      nullable: true,
      description: 'One starship by identifier, or null when no such starship exists.',
      args: { id: t.arg.id({ required: true, description: "The starship's identifier." }) },
      resolve: (_root, { id }) => id
    }),

    vehicles: t.field({
      type: [vehicleType],
      description: 'Every vehicle, ordered by name.',
      resolve: (_root, _args, context) => context.repositories.vehicles.list()
    }),
    vehicle: t.field({
      type: vehicleType,
      nullable: true,
      description: 'One vehicle by identifier, or null when no such vehicle exists.',
      args: { id: t.arg.id({ required: true, description: "The vehicle's identifier." }) },
      resolve: (_root, { id }) => id
    })
  })
});

/**
 * The executable schema.
 *
 * Built once at module scope rather than per request: schema construction is pure and moderately
 * expensive, and a Worker isolate serves many requests. Only the _context_ is per-request — see
 * `./context.ts` — which is what keeps caller data from being shared while still paying the schema
 * cost once per isolate.
 *
 * There is no `Mutation` type. Nothing in this API can write, and the absence is visible in the
 * published schema: a client introspecting it is told so, rather than discovering it from a runtime
 * error. The planned data editor will add one here, behind its own Access application.
 */
export const schema = builder.toSchema();
