import { env, exports } from "cloudflare:workers";
import { execute, parse } from "graphql";
import { describe, expect, it } from "vitest";
import type { AppBindings } from "../../src/worker/bindings";
import { createGraphQLServerContext } from "../../src/worker/graphql/observability";
import { schema } from "../../src/worker/graphql/schema";

/** A successful GraphQL response with the selected data shape. */
interface GraphQLResponse<T> {
  /** Data selected by the GraphQL operation. */
  data: T;
  /** GraphQL errors, which must be absent in correctness tests. */
  errors?: { message: string }[];
}

/** Executes a GraphQL operation through the deployed Worker entrypoint. */
async function graphql<T>(
  query: string,
  variables?: Record<string, string>,
): Promise<T> {
  const response = await exports.default.fetch(
    new Request("https://swapi.example/graphql", {
      body: JSON.stringify({ query, variables }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);

  const result = (await response.json()) as GraphQLResponse<T>;
  expect(result.errors).toBeUndefined();
  return result.data;
}

/** Obtains a seeded entity id without coupling tests to generated UUID values. */
async function firstId(root: string): Promise<string> {
  const data = await graphql<Record<string, { id: string }[]>>(
    `{ ${root} { id } }`,
  );
  expect(data[root]).not.toHaveLength(0);
  return data[root][0].id;
}

describe("SWAPI GraphQL API", () => {
  it.each([
    ["films", "film", "title"],
    ["people", "person", "name"],
    ["planets", "planet", "name"],
    ["speciesList", "species", "name"],
    ["starships", "starship", "name"],
    ["vehicles", "vehicle", "name"],
  ])("returns the %s flat list and %s by id", async (list, byId, scalar) => {
    const listData = await graphql<Record<string, { id: string }[]>>(
      `{ ${list} { id ${scalar} } }`,
    );
    const item = listData[list][0];
    expect(item).toBeDefined();

    const byIdData = await graphql<Record<string, { id: string } | null>>(
      `query Entity($id: ID!) { ${byId}(id: $id) { id ${scalar} } }`,
      { id: item.id },
    );
    expect(byIdData[byId]).toEqual(item);
  });

  it("returns every direct relation field from each entity type", async () => {
    const [filmId, personId, planetId, speciesId, starshipId, vehicleId] =
      await Promise.all([
        firstId("films"),
        firstId("people"),
        firstId("planets"),
        firstId("speciesList"),
        firstId("starships"),
        firstId("vehicles"),
      ]);

    const data = await graphql<{
      film: Record<string, unknown>;
      person: Record<string, unknown>;
      planet: Record<string, unknown>;
      species: Record<string, unknown>;
      starship: Record<string, unknown>;
      vehicle: Record<string, unknown>;
    }>(
      `query Relations($filmId: ID!, $personId: ID!, $planetId: ID!, $speciesId: ID!, $starshipId: ID!, $vehicleId: ID!) {
        film(id: $filmId) { characters { id } planets { id } species { id } starships { id } vehicles { id } }
        person(id: $personId) { homeworld { id } species { id } films { id } starships { id } vehicles { id } }
        planet(id: $planetId) { residents { id } films { id } }
        species(id: $speciesId) { homeworld { id } people { id } films { id } }
        starship(id: $starshipId) { pilots { id } films { id } }
        vehicle(id: $vehicleId) { pilots { id } films { id } }
      }`,
      { filmId, personId, planetId, speciesId, starshipId, vehicleId },
    );

    expect(data.film).toEqual(
      expect.objectContaining({
        characters: expect.any(Array),
        planets: expect.any(Array),
        species: expect.any(Array),
        starships: expect.any(Array),
        vehicles: expect.any(Array),
      }),
    );
    expect(data.person).toEqual(
      expect.objectContaining({
        films: expect.any(Array),
        starships: expect.any(Array),
        vehicles: expect.any(Array),
      }),
    );
    expect(data.planet).toEqual(
      expect.objectContaining({
        residents: expect.any(Array),
        films: expect.any(Array),
      }),
    );
    expect(data.species).toEqual(
      expect.objectContaining({
        people: expect.any(Array),
        films: expect.any(Array),
      }),
    );
    expect(data.starship).toEqual(
      expect.objectContaining({
        pilots: expect.any(Array),
        films: expect.any(Array),
      }),
    );
    expect(data.vehicle).toEqual(
      expect.objectContaining({
        pilots: expect.any(Array),
        films: expect.any(Array),
      }),
    );
    expect([null, expect.any(Object)]).toContainEqual(data.person.homeworld);
    expect([null, expect.any(Object)]).toContainEqual(data.person.species);
    expect([null, expect.any(Object)]).toContainEqual(data.species.homeworld);
  });

  it("resolves the documented Film to Person to Planet relationship", async () => {
    const data = await graphql<{
      films: {
        title: string;
        characters: { name: string; homeworld: { name: string } | null }[];
      }[];
    }>(`{ films { title characters { name homeworld { name } } } }`);
    const newHope = data.films.find((film) => film.title === "A New Hope");
    const luke = newHope?.characters.find(
      (character) => character.name === "Luke Skywalker",
    );

    expect(luke?.homeworld).toEqual({ name: "Tatooine" });
  });

  it("batches a nested many-to-many query into one relation statement", async () => {
    const context = createGraphQLServerContext(env as AppBindings);
    const result = await execute({
      contextValue: context.env,
      document: parse("{ films { id characters { id } } }"),
      schema,
    });
    expect(result.errors).toBeUndefined();

    const films = (result.data as { films: { id: string }[] }).films;
    expect(films.length).toBeGreaterThan(1);
    expect(context.telemetry.statementCount()).toBe(2);
  });

  it("caps every parent's many-to-many child list with first", async () => {
    const data = await graphql<{
      films: { characters: { id: string }[] }[];
    }>(`{ films { characters(first: 2) { id } } }`);

    expect(data.films).not.toHaveLength(0);
    expect(data.films.every((film) => film.characters.length <= 2)).toBe(true);
  });

  it("redirects the hostname root to GraphiQL", async () => {
    const response = await exports.default.fetch(
      new Request("https://swapi.example/", { redirect: "manual" }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/graphql");
  });
});
