/**
 * @file Fields of the `Planet` type. `residents` is the reverse of `Person.homeworld`, and the two
 *   are resolved by different SQL shapes despite describing the same relationship: the forward
 *   direction reads a foreign key off the character's own row, while this direction queries
 *   characters _by_ that foreign key. Both are batched, so traversing the relation in either
 *   direction costs one statement per request.
 */

import { validateRelationLimit } from '../../../domain/relation-limit';
import { filmType, personType, planetType, relationFieldOptions } from './refs';

planetType.implement({
  description: 'A planet in the Star Wars galaxy.',
  fields: (t) => ({
    id: t.exposeID('id', { description: 'Stable identifier for this planet.' }),
    name: t.exposeString('name', { description: "The planet's name." }),
    rotationPeriod: t.exposeString('rotationPeriod', {
      description: 'Rotation period in standard hours, as text.'
    }),
    orbitalPeriod: t.exposeString('orbitalPeriod', {
      description: 'Orbital period in standard days, as text.'
    }),
    diameter: t.exposeString('diameter', {
      description: 'Diameter in kilometres, as text.'
    }),
    climate: t.exposeString('climate', {
      description: 'Comma-separated climate descriptions.'
    }),
    gravity: t.exposeString('gravity', {
      description: 'Gravity relative to standard, as text.'
    }),
    terrain: t.exposeString('terrain', {
      description: 'Comma-separated terrain descriptions.'
    }),
    surfaceWater: t.exposeString('surfaceWater', {
      description: 'Percentage of the surface covered by water, as text.'
    }),
    population: t.exposeString('population', {
      description: 'Population, as text; may be `unknown`.'
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

    residents: t.loadableGroup({
      ...relationFieldOptions,
      type: personType,
      description: 'Characters who call this planet home, ordered by name.',
      args: {
        first: t.arg.int({ description: 'Maximum residents to return for this planet, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.people.findByPlanetIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (planet) => planet.id
    }),

    films: t.loadableGroup({
      ...relationFieldOptions,
      type: filmType,
      description: 'Films this planet appears in, in saga order.',
      args: {
        first: t.arg.int({ description: 'Maximum films to return for this planet, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.films.findByPlanetIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (planet) => planet.id
    })
  })
});
