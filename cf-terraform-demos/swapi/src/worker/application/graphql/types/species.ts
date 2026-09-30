/**
 * @file Fields of the `Species` type.
 */

import { validateRelationLimit } from '../../../domain/relation-limit';
import { filmType, personType, planetType, relationFieldOptions, speciesType } from './refs';

speciesType.implement({
  description: 'A species in the Star Wars galaxy.',
  fields: (t) => ({
    id: t.exposeID('id', { description: 'Stable identifier for this species.' }),
    name: t.exposeString('name', { description: "The species' name." }),
    classification: t.exposeString('classification', {
      description: 'Biological classification, such as `mammal`.'
    }),
    designation: t.exposeString('designation', {
      description: 'Designation, such as `sentient`.'
    }),
    averageHeight: t.exposeString('averageHeight', {
      description: 'Average height in centimetres, as text.'
    }),
    skinColors: t.exposeString('skinColors', {
      description: 'Comma-separated skin colours.'
    }),
    hairColors: t.exposeString('hairColors', {
      description: 'Comma-separated hair colours.'
    }),
    eyeColors: t.exposeString('eyeColors', {
      description: 'Comma-separated eye colours.'
    }),
    averageLifespan: t.exposeString('averageLifespan', {
      description: 'Average lifespan in standard years, as text; may be `indefinite`.'
    }),
    language: t.exposeString('language', { description: 'Primary language.' }),
    created: t.exposeString('created', {
      description: 'ISO-8601 timestamp when the source record was created.'
    }),
    edited: t.exposeString('edited', {
      description: 'ISO-8601 timestamp when the source record was last edited.'
    }),
    url: t.exposeString('url', {
      description: 'Canonical upstream resource URL this record was seeded from.'
    }),

    homeworld: t.field({
      type: planetType,
      nullable: true,
      description: "The species' home planet, or null when the dataset records none.",
      resolve: (species) => species.homeworldId
    }),

    people: t.loadableGroup({
      ...relationFieldOptions,
      type: personType,
      description: 'Characters belonging to this species, ordered by name.',
      args: {
        first: t.arg.int({
          description: 'Maximum characters to return for this species, 1 to 100.'
        })
      },
      load: (ids, context, args) =>
        context.repositories.people.findBySpeciesIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (species) => species.id
    }),

    films: t.loadableGroup({
      ...relationFieldOptions,
      type: filmType,
      description: 'Films this species appears in, in saga order.',
      args: {
        first: t.arg.int({ description: 'Maximum films to return for this species, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.films.findBySpeciesIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (species) => species.id
    })
  })
});
