/**
 * @file Fields of the `Starship` type. A starship is distinguished from a vehicle by having a
 *   hyperdrive, which is why `hyperdriveRating` and `mglt` appear here and not on `Vehicle`. The
 *   two types are otherwise parallel, and both are seeded from separate upstream collections rather
 *   than one table with a discriminator.
 */

import { validateRelationLimit } from '../../../domain/relation-limit';
import { filmType, personType, relationFieldOptions, starshipType } from './refs';

starshipType.implement({
  description: 'A starship: a craft with hyperdrive capability.',
  fields: (t) => ({
    id: t.exposeID('id', { description: 'Stable identifier for this starship.' }),
    name: t.exposeString('name', { description: "The starship's common name." }),
    model: t.exposeString('model', { description: 'Model designation.' }),
    manufacturer: t.exposeString('manufacturer', {
      description: 'Comma-separated manufacturers.'
    }),
    costInCredits: t.exposeString('costInCredits', {
      description: 'Cost in galactic credits, as text; may be `unknown`.'
    }),
    length: t.exposeString('length', { description: 'Length in metres, as text.' }),
    maxAtmospheringSpeed: t.exposeString('maxAtmospheringSpeed', {
      description: 'Maximum atmospheric speed, as text.'
    }),
    crew: t.exposeString('crew', { description: 'Crew complement, as text.' }),
    passengers: t.exposeString('passengers', {
      description: 'Passenger capacity, as text.'
    }),
    cargoCapacity: t.exposeString('cargoCapacity', {
      description: 'Cargo capacity in kilograms, as text.'
    }),
    consumables: t.exposeString('consumables', {
      description: 'How long the ship can provide consumables for its crew.'
    }),
    hyperdriveRating: t.exposeString('hyperdriveRating', {
      description: 'Hyperdrive class rating, as text.'
    }),
    mglt: t.exposeString('mglt', {
      description: 'Maximum speed in Modern Galactic Light Time units, as text.'
    }),
    starshipClass: t.exposeString('starshipClass', {
      description: 'Class of starship, such as `Star Destroyer`.'
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

    pilots: t.loadableGroup({
      ...relationFieldOptions,
      type: personType,
      description: 'Characters who pilot this starship, ordered by name.',
      args: {
        first: t.arg.int({ description: 'Maximum pilots to return for this starship, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.people.findByStarshipIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (starship) => starship.id
    }),

    films: t.loadableGroup({
      ...relationFieldOptions,
      type: filmType,
      description: 'Films this starship appears in, in saga order.',
      args: {
        first: t.arg.int({ description: 'Maximum films to return for this starship, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.films.findByStarshipIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (starship) => starship.id
    })
  })
});
