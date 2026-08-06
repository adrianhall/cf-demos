import { describe, expect, it, vi } from "vitest";
import type { AppBindings } from "../../bindings";
import {
  findFilmsByPersonId,
  findFilmsByPlanetId,
  findFilmsBySpeciesId,
  findFilmsByStarshipId,
  findFilmsByVehicleId,
} from "./film";
import {
  findPeopleByFilmId,
  findPeopleByStarshipId,
  findPeopleByVehicleId,
} from "./person";
import { findPlanetsByFilmId } from "./planet";
import { findSpeciesByFilmId } from "./species";
import { findStarshipsByFilmId, findStarshipsByPersonId } from "./starship";
import { findVehiclesByFilmId, findVehiclesByPersonId } from "./vehicle";

/** A minimal D1 binding spy for testing a repository's query boundary. */
function createRepositoryEnv(): {
  env: AppBindings;
  bind: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
} {
  const bind = vi.fn();
  const statement = {
    all: vi.fn().mockResolvedValue({ results: [] }),
    bind,
  };
  bind.mockReturnValue(statement);
  const prepare = vi.fn().mockReturnValue(statement);

  return {
    env: { DB: { prepare } as unknown as D1Database },
    bind,
    prepare,
  };
}

describe("intentionally naive many-to-many repositories", () => {
  it.each([
    ["films by person", findFilmsByPersonId],
    ["films by planet", findFilmsByPlanetId],
    ["films by species", findFilmsBySpeciesId],
    ["films by starship", findFilmsByStarshipId],
    ["films by vehicle", findFilmsByVehicleId],
    ["people by film", findPeopleByFilmId],
    ["people by starship", findPeopleByStarshipId],
    ["people by vehicle", findPeopleByVehicleId],
    ["planets by film", findPlanetsByFilmId],
    ["species by film", findSpeciesByFilmId],
    ["starships by film", findStarshipsByFilmId],
    ["starships by person", findStarshipsByPersonId],
    ["vehicles by film", findVehiclesByFilmId],
    ["vehicles by person", findVehiclesByPersonId],
  ])("issues one direct statement for %s", async (_name, repository) => {
    const { bind, env, prepare } = createRepositoryEnv();

    await repository(env, "parent-id");

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith("parent-id");
  });
});
