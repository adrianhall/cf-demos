/**
 * @file Fields of the `Person` type. This type shows both relation styles side by side. `homeworld`
 *   and `species` are single-valued: the identifier is already a column on the character's own row,
 *   so the resolver just returns it and the loadable reference (see `./refs.ts`) batches the
 *   lookup. `films`, `starships`, and `vehicles` are multi-valued and go through `loadableGroup`,
 *   which issues one grouped query per relation per request.
 */

import { validateRelationLimit } from '../../../domain/relation-limit';
import {
  filmType,
  personType,
  planetType,
  relationFieldOptions,
  speciesType,
  starshipType,
  vehicleType
} from './refs';

personType.implement({
  description: 'A character in the Star Wars saga.',
  fields: (t) => ({
    id: t.exposeID('id', { description: 'Stable identifier for this character.' }),
    name: t.exposeString('name', { description: "The character's name." }),
    height: t.exposeString('height', {
      description: 'Height in centimetres, as text; may be `unknown`.'
    }),
    mass: t.exposeString('mass', {
      description: 'Mass in kilograms, as text; may be `unknown`.'
    }),
    hairColor: t.exposeString('hairColor', {
      description: 'Hair colour, or a sentinel such as `n/a`.'
    }),
    skinColor: t.exposeString('skinColor', { description: 'Skin colour.' }),
    eyeColor: t.exposeString('eyeColor', { description: 'Eye colour.' }),
    birthYear: t.exposeString('birthYear', {
      description: 'Birth year in in-universe notation, such as `19BBY`, or `unknown`.'
    }),
    gender: t.exposeString('gender', {
      description: 'Gender, or a sentinel such as `n/a` for droids.'
    }),
    created: t.exposeString('created', {
      description: 'ISO-8601 timestamp when the source record was created.'
    }),
    edited: t.exposeString('edited', {
      description: 'ISO-8601 timestamp when the source record was last edited.'
    }),
    url: t.exposeString('url', {
      description: 'Canonical upstream resource URL this record was seeded from.'
    }),

    // Single-valued relations. The resolver returns the foreign key already present on the row and
    // the loadable reference turns it into an entity, so no statement is issued unless the field is
    // actually selected — and when it is, every character's homeworld in the query is fetched in
    // one batch. `null` when the dataset records no homeworld, which the nullable field allows
    // without an error.
    homeworld: t.field({
      type: planetType,
      nullable: true,
      description: "The character's home planet, or null when the dataset records none.",
      resolve: (person) => person.homeworldId
    }),

    species: t.field({
      type: speciesType,
      nullable: true,
      description: "The character's species, or null when the dataset records none.",
      resolve: (person) => person.speciesId
    }),

    films: t.loadableGroup({
      ...relationFieldOptions,
      type: filmType,
      description: 'Films this character appears in, in saga order.',
      args: {
        first: t.arg.int({ description: 'Maximum films to return for this character, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.films.findByPersonIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (person) => person.id
    }),

    starships: t.loadableGroup({
      ...relationFieldOptions,
      type: starshipType,
      description: 'Starships this character pilots, ordered by name.',
      args: {
        first: t.arg.int({
          description: 'Maximum starships to return for this character, 1 to 100.'
        })
      },
      load: (ids, context, args) =>
        context.repositories.starships.findByPersonIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (person) => person.id
    }),

    vehicles: t.loadableGroup({
      ...relationFieldOptions,
      type: vehicleType,
      description: 'Vehicles this character pilots, ordered by name.',
      args: {
        first: t.arg.int({
          description: 'Maximum vehicles to return for this character, 1 to 100.'
        })
      },
      load: (ids, context, args) =>
        context.repositories.vehicles.findByPersonIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (person) => person.id
    })
  })
});
