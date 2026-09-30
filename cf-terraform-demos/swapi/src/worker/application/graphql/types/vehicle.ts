/**
 * @file Fields of the `Vehicle` type. Vehicles are craft without hyperdrive capability, which is
 *   the only structural difference from `Starship`: this type has a `vehicleClass` where that one
 *   has `starshipClass`, `hyperdriveRating`, and `mglt`.
 */

import { validateRelationLimit } from '../../../domain/relation-limit';
import { filmType, personType, relationFieldOptions, vehicleType } from './refs';

vehicleType.implement({
  description: 'A vehicle: a craft without hyperdrive capability.',
  fields: (t) => ({
    id: t.exposeID('id', { description: 'Stable identifier for this vehicle.' }),
    name: t.exposeString('name', { description: "The vehicle's common name." }),
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
      description: 'How long the vehicle can provide consumables for its crew.'
    }),
    vehicleClass: t.exposeString('vehicleClass', {
      description: 'Class of vehicle, such as `wheeled walker`.'
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
      description: 'Characters who pilot this vehicle, ordered by name.',
      args: {
        first: t.arg.int({ description: 'Maximum pilots to return for this vehicle, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.people.findByVehicleIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (vehicle) => vehicle.id
    }),

    films: t.loadableGroup({
      ...relationFieldOptions,
      type: filmType,
      description: 'Films this vehicle appears in, in saga order.',
      args: {
        first: t.arg.int({ description: 'Maximum films to return for this vehicle, 1 to 100.' })
      },
      load: (ids, context, args) =>
        context.repositories.films.findByVehicleIds(
          ids.map(String),
          validateRelationLimit(args.first)
        ),
      resolve: (vehicle) => vehicle.id
    })
  })
});
