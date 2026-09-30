/**
 * @file Fields of the `Film` type. Every multi-valued relation here is a `loadableGroup`, which is
 *   what makes a query like `films { characters { name } }` cost one statement for the films and
 *   one for the characters of all of them, rather than one statement per film. Each relation
 *   exposes an optional `first` argument, validated by the domain tier and pushed down into SQL as
 *   a per-parent limit rather than applied after the fact — so `first: 3` reads three rows per film
 *   out of the database instead of reading all of them and discarding the rest.
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

filmType.implement({
  description: 'A film in the Star Wars saga.',
  fields: (t) => ({
    id: t.exposeID('id', { description: 'Stable identifier for this film.' }),
    episodeId: t.exposeString('episodeId', {
      description: 'Episode number within the saga, as text.'
    }),
    title: t.exposeString('title', { description: "The film's title." }),
    openingCrawl: t.exposeString('openingCrawl', {
      description: "Full text of the film's opening crawl, including line breaks."
    }),
    director: t.exposeString('director', { description: "The director's name." }),
    producer: t.exposeString('producer', {
      description: 'Comma-separated list of producers.'
    }),
    releaseDate: t.exposeString('releaseDate', {
      description: 'Original release date, as `YYYY-MM-DD`.'
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

    characters: t.loadableGroup({
      ...relationFieldOptions,
      type: personType,
      description: 'Characters appearing in this film, ordered by name.',
      args: {
        first: t.arg.int({ description: 'Maximum characters to return for this film, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.people.findByFilmIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (film) => film.id
    }),

    planets: t.loadableGroup({
      ...relationFieldOptions,
      type: planetType,
      description: 'Planets appearing in this film, ordered by name.',
      args: {
        first: t.arg.int({ description: 'Maximum planets to return for this film, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.planets.findByFilmIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (film) => film.id
    }),

    species: t.loadableGroup({
      ...relationFieldOptions,
      type: speciesType,
      description: 'Species appearing in this film, ordered by name.',
      args: {
        first: t.arg.int({ description: 'Maximum species to return for this film, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.species.findByFilmIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (film) => film.id
    }),

    starships: t.loadableGroup({
      ...relationFieldOptions,
      type: starshipType,
      description: 'Starships appearing in this film, ordered by name.',
      args: {
        first: t.arg.int({ description: 'Maximum starships to return for this film, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.starships.findByFilmIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (film) => film.id
    }),

    vehicles: t.loadableGroup({
      ...relationFieldOptions,
      type: vehicleType,
      description: 'Vehicles appearing in this film, ordered by name.',
      args: {
        first: t.arg.int({ description: 'Maximum vehicles to return for this film, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.vehicles.findByFilmIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (film) => film.id
    })
  })
});
