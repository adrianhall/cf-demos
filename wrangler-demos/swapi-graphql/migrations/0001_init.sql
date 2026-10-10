PRAGMA foreign_keys = ON;

CREATE TABLE film (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  opening_crawl TEXT NOT NULL,
  director TEXT NOT NULL,
  producer TEXT NOT NULL,
  release_date TEXT NOT NULL,
  created TEXT NOT NULL,
  edited TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE
);

CREATE TABLE planet (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rotation_period TEXT NOT NULL,
  orbital_period TEXT NOT NULL,
  diameter TEXT NOT NULL,
  climate TEXT NOT NULL,
  gravity TEXT NOT NULL,
  terrain TEXT NOT NULL,
  surface_water TEXT NOT NULL,
  population TEXT NOT NULL,
  created TEXT NOT NULL,
  edited TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE
);

CREATE TABLE species (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  classification TEXT NOT NULL,
  designation TEXT NOT NULL,
  average_height TEXT NOT NULL,
  skin_colors TEXT NOT NULL,
  hair_colors TEXT NOT NULL,
  eye_colors TEXT NOT NULL,
  average_lifespan TEXT NOT NULL,
  homeworld_id TEXT REFERENCES planet(id) ON DELETE SET NULL,
  language TEXT NOT NULL,
  created TEXT NOT NULL,
  edited TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE
);

CREATE TABLE person (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  height TEXT NOT NULL,
  mass TEXT NOT NULL,
  hair_color TEXT NOT NULL,
  skin_color TEXT NOT NULL,
  eye_color TEXT NOT NULL,
  birth_year TEXT NOT NULL,
  gender TEXT NOT NULL,
  homeworld_id TEXT REFERENCES planet(id) ON DELETE SET NULL,
  species_id TEXT REFERENCES species(id) ON DELETE SET NULL,
  created TEXT NOT NULL,
  edited TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE
);

CREATE TABLE starship (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  cost_in_credits TEXT NOT NULL,
  length TEXT NOT NULL,
  max_atmosphering_speed TEXT NOT NULL,
  crew TEXT NOT NULL,
  passengers TEXT NOT NULL,
  cargo_capacity TEXT NOT NULL,
  consumables TEXT NOT NULL,
  hyperdrive_rating TEXT NOT NULL,
  mglt TEXT NOT NULL,
  starship_class TEXT NOT NULL,
  created TEXT NOT NULL,
  edited TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE
);

CREATE TABLE vehicle (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  cost_in_credits TEXT NOT NULL,
  length TEXT NOT NULL,
  max_atmosphering_speed TEXT NOT NULL,
  crew TEXT NOT NULL,
  passengers TEXT NOT NULL,
  cargo_capacity TEXT NOT NULL,
  consumables TEXT NOT NULL,
  vehicle_class TEXT NOT NULL,
  created TEXT NOT NULL,
  edited TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE
);

CREATE TABLE film_person (
  film_id TEXT NOT NULL REFERENCES film(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  PRIMARY KEY (film_id, person_id)
);

CREATE TABLE film_planet (
  film_id TEXT NOT NULL REFERENCES film(id) ON DELETE CASCADE,
  planet_id TEXT NOT NULL REFERENCES planet(id) ON DELETE CASCADE,
  PRIMARY KEY (film_id, planet_id)
);

CREATE TABLE film_species (
  film_id TEXT NOT NULL REFERENCES film(id) ON DELETE CASCADE,
  species_id TEXT NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  PRIMARY KEY (film_id, species_id)
);

CREATE TABLE film_starship (
  film_id TEXT NOT NULL REFERENCES film(id) ON DELETE CASCADE,
  starship_id TEXT NOT NULL REFERENCES starship(id) ON DELETE CASCADE,
  PRIMARY KEY (film_id, starship_id)
);

CREATE TABLE film_vehicle (
  film_id TEXT NOT NULL REFERENCES film(id) ON DELETE CASCADE,
  vehicle_id TEXT NOT NULL REFERENCES vehicle(id) ON DELETE CASCADE,
  PRIMARY KEY (film_id, vehicle_id)
);

CREATE TABLE person_starship (
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  starship_id TEXT NOT NULL REFERENCES starship(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, starship_id)
);

CREATE TABLE person_vehicle (
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  vehicle_id TEXT NOT NULL REFERENCES vehicle(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, vehicle_id)
);

CREATE INDEX idx_person_homeworld ON person(homeworld_id);
CREATE INDEX idx_person_species ON person(species_id);
CREATE INDEX idx_species_homeworld ON species(homeworld_id);

-- These indexes make each naive per-parent relation query fast individually;
-- they do not reduce the N+1 call count that this demo intentionally exposes.
CREATE INDEX idx_film_person_reverse ON film_person(person_id, film_id);
CREATE INDEX idx_film_planet_reverse ON film_planet(planet_id, film_id);
CREATE INDEX idx_film_species_reverse ON film_species(species_id, film_id);
CREATE INDEX idx_film_starship_reverse ON film_starship(starship_id, film_id);
CREATE INDEX idx_film_vehicle_reverse ON film_vehicle(vehicle_id, film_id);
CREATE INDEX idx_person_starship_reverse ON person_starship(starship_id, person_id);
CREATE INDEX idx_person_vehicle_reverse ON person_vehicle(vehicle_id, person_id);
