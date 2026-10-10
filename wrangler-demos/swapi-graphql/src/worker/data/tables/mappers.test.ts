import { describe, expect, it } from "vitest";
import { mapFilm } from "./film";
import { mapPerson } from "./person";
import { mapPlanet } from "./planet";
import { mapSpecies } from "./species";
import { mapStarship } from "./starship";
import { mapVehicle } from "./vehicle";

describe("SWAPI row mappers", () => {
  it("maps every film column to its GraphQL-facing name", () => {
    expect(
      mapFilm({
        id: "film-1",
        episode_id: "4",
        title: "A New Hope",
        opening_crawl: "crawl",
        director: "George Lucas",
        producer: "Gary Kurtz",
        release_date: "1977-05-25",
        created: "created",
        edited: "edited",
        url: "https://example.test/films/1",
      }),
    ).toEqual({
      id: "film-1",
      episodeId: "4",
      title: "A New Hope",
      openingCrawl: "crawl",
      director: "George Lucas",
      producer: "Gary Kurtz",
      releaseDate: "1977-05-25",
      created: "created",
      edited: "edited",
      url: "https://example.test/films/1",
    });
  });

  it("maps nullable person foreign keys and snake_case scalar columns", () => {
    expect(
      mapPerson({
        id: "person-1",
        name: "Luke",
        height: "172",
        mass: "77",
        hair_color: "blond",
        skin_color: "fair",
        eye_color: "blue",
        birth_year: "19BBY",
        gender: "male",
        homeworld_id: "planet-1",
        species_id: null,
        created: "created",
        edited: "edited",
        url: "https://example.test/people/1",
      }),
    ).toEqual({
      id: "person-1",
      name: "Luke",
      height: "172",
      mass: "77",
      hairColor: "blond",
      skinColor: "fair",
      eyeColor: "blue",
      birthYear: "19BBY",
      gender: "male",
      homeworldId: "planet-1",
      speciesId: null,
      created: "created",
      edited: "edited",
      url: "https://example.test/people/1",
    });
  });

  it("maps every planet scalar column", () => {
    expect(
      mapPlanet({
        id: "planet-1",
        name: "Tatooine",
        rotation_period: "23",
        orbital_period: "304",
        diameter: "10465",
        climate: "arid",
        gravity: "1 standard",
        terrain: "desert",
        surface_water: "1",
        population: "200000",
        created: "created",
        edited: "edited",
        url: "https://example.test/planets/1",
      }),
    ).toEqual({
      id: "planet-1",
      name: "Tatooine",
      rotationPeriod: "23",
      orbitalPeriod: "304",
      diameter: "10465",
      climate: "arid",
      gravity: "1 standard",
      terrain: "desert",
      surfaceWater: "1",
      population: "200000",
      created: "created",
      edited: "edited",
      url: "https://example.test/planets/1",
    });
  });

  it("maps nullable species homeworld and all descriptive fields", () => {
    expect(
      mapSpecies({
        id: "species-1",
        name: "Human",
        classification: "mammal",
        designation: "sentient",
        average_height: "180",
        skin_colors: "caucasian",
        hair_colors: "blond",
        eye_colors: "blue",
        average_lifespan: "120",
        homeworld_id: null,
        language: "Galactic Basic",
        created: "created",
        edited: "edited",
        url: "https://example.test/species/1",
      }),
    ).toEqual({
      id: "species-1",
      name: "Human",
      classification: "mammal",
      designation: "sentient",
      averageHeight: "180",
      skinColors: "caucasian",
      hairColors: "blond",
      eyeColors: "blue",
      averageLifespan: "120",
      homeworldId: null,
      language: "Galactic Basic",
      created: "created",
      edited: "edited",
      url: "https://example.test/species/1",
    });
  });

  it("maps every starship scalar column", () => {
    expect(
      mapStarship({
        id: "starship-1",
        name: "X-wing",
        model: "T-65",
        manufacturer: "Incom",
        cost_in_credits: "149999",
        length: "12.5",
        max_atmosphering_speed: "1050",
        crew: "1",
        passengers: "0",
        cargo_capacity: "110",
        consumables: "1 week",
        hyperdrive_rating: "1.0",
        mglt: "100",
        starship_class: "Starfighter",
        created: "created",
        edited: "edited",
        url: "https://example.test/starships/1",
      }),
    ).toEqual({
      id: "starship-1",
      name: "X-wing",
      model: "T-65",
      manufacturer: "Incom",
      costInCredits: "149999",
      length: "12.5",
      maxAtmospheringSpeed: "1050",
      crew: "1",
      passengers: "0",
      cargoCapacity: "110",
      consumables: "1 week",
      hyperdriveRating: "1.0",
      mglt: "100",
      starshipClass: "Starfighter",
      created: "created",
      edited: "edited",
      url: "https://example.test/starships/1",
    });
  });

  it("maps every vehicle scalar column", () => {
    expect(
      mapVehicle({
        id: "vehicle-1",
        name: "Sand Crawler",
        model: "Digger",
        manufacturer: "Corellia",
        cost_in_credits: "150000",
        length: "36.8",
        max_atmosphering_speed: "30",
        crew: "46",
        passengers: "30",
        cargo_capacity: "50000",
        consumables: "2 months",
        vehicle_class: "wheeled",
        created: "created",
        edited: "edited",
        url: "https://example.test/vehicles/1",
      }),
    ).toEqual({
      id: "vehicle-1",
      name: "Sand Crawler",
      model: "Digger",
      manufacturer: "Corellia",
      costInCredits: "150000",
      length: "36.8",
      maxAtmospheringSpeed: "30",
      crew: "46",
      passengers: "30",
      cargoCapacity: "50000",
      consumables: "2 months",
      vehicleClass: "wheeled",
      created: "created",
      edited: "edited",
      url: "https://example.test/vehicles/1",
    });
  });
});
