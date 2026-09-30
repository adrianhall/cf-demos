import { describe, expect, it } from 'vitest';
import {
  D1FilmRepository,
  D1PersonRepository,
  D1PlanetRepository,
  createD1Repositories
} from '../../../src/worker/infrastructure/d1-repositories';
import { createFakeD1 } from '../support/fake-d1';

/**
 * A complete `film` row, used to check that mapping covers every column rather than only the ones
 * an assertion happens to read.
 */
const filmRow = {
  id: 'film-1',
  episode_id: '4',
  title: 'A New Hope',
  opening_crawl: 'It is a period of civil war.',
  director: 'George Lucas',
  producer: 'Gary Kurtz, Rick McCallum',
  release_date: '1977-05-25',
  created: '2014-12-10T14:23:31.880000Z',
  edited: '2014-12-20T19:49:45.256000Z',
  url: 'https://swapi.info/api/films/1'
};

/**
 * A complete `person` row, including both nullable foreign keys.
 */
const personRow = {
  id: 'person-1',
  name: 'Luke Skywalker',
  height: '172',
  mass: '77',
  hair_color: 'blond',
  skin_color: 'fair',
  eye_color: 'blue',
  birth_year: '19BBY',
  gender: 'male',
  homeworld_id: 'planet-1',
  species_id: null,
  created: '2014-12-09T13:50:51.644000Z',
  edited: '2014-12-20T21:17:56.891000Z',
  url: 'https://swapi.info/api/people/1'
};

describe('D1FilmRepository', () => {
  it('maps every column of a listed row into the domain shape', async () => {
    const fake = createFakeD1([filmRow]);
    const [film] = await new D1FilmRepository(fake.database).list();

    // The full assertion is deliberate. A partial one would still pass if a snake_case column were
    // dropped or misspelled in the mapper, which is exactly the mistake this tier can make.
    expect(film).toEqual({
      id: 'film-1',
      episodeId: '4',
      title: 'A New Hope',
      openingCrawl: 'It is a period of civil war.',
      director: 'George Lucas',
      producer: 'Gary Kurtz, Rick McCallum',
      releaseDate: '1977-05-25',
      created: '2014-12-10T14:23:31.880000Z',
      edited: '2014-12-20T19:49:45.256000Z',
      url: 'https://swapi.info/api/films/1'
    });
  });

  it('lists films in saga order rather than insertion order', async () => {
    const fake = createFakeD1();
    await new D1FilmRepository(fake.database).list();

    expect(fake.statements[0].sql).toContain('ORDER BY film.episode_id');
  });

  it('never selects with a star projection', async () => {
    // An explicit projection keeps the result shape independent of the migration's column order.
    const fake = createFakeD1();
    await new D1FilmRepository(fake.database).list();

    expect(fake.statements[0].sql).not.toContain('SELECT *');
    expect(fake.statements[0].sql).toContain('film.opening_crawl');
  });

  it('loads a batch of identifiers in a single statement', async () => {
    const fake = createFakeD1();
    await new D1FilmRepository(fake.database).findByIds(['a', 'b', 'c']);

    // One statement for three identifiers is the property the whole design exists to guarantee.
    expect(fake.statements).toHaveLength(1);
    expect(fake.statements[0].sql).toContain('IN (?, ?, ?)');
    expect(fake.statements[0].parameters).toEqual(['a', 'b', 'c']);
  });

  it('binds only the parent identifiers when no limit is requested', async () => {
    const fake = createFakeD1();
    await new D1FilmRepository(fake.database).findByPersonIds(['p1', 'p2']);

    expect(fake.statements[0].parameters).toEqual(['p1', 'p2']);
  });

  it('binds the per-parent limit after the parent identifiers', async () => {
    const fake = createFakeD1();
    await new D1FilmRepository(fake.database).findByPersonIds(['p1', 'p2'], 5);

    // Order matters: the statement builder emits the IN placeholders first and the row_number
    // comparison last, so a reversed binding would silently filter by the wrong value.
    expect(fake.statements[0].parameters).toEqual(['p1', 'p2', 5]);
  });

  it('tags each related row with the parent it belongs to', async () => {
    const fake = createFakeD1([{ ...filmRow, parent_id: 'person-7' }]);
    const [film] = await new D1FilmRepository(fake.database).findByPersonIds(['person-7']);

    // Without this tag the loader cannot split one batched result back into per-parent lists.
    expect(film.parentId).toBe('person-7');
    expect(film.title).toBe('A New Hope');
  });

  it('returns an empty array when no rows match, rather than raising', async () => {
    const fake = createFakeD1();
    await expect(new D1FilmRepository(fake.database).findByIds(['missing'])).resolves.toEqual([]);
  });

  it('rejects an empty batch, which indicates a caller bug', async () => {
    // A loader should never ask for zero keys; failing loudly surfaces that rather than issuing a
    // statement that cannot match anything.
    const fake = createFakeD1();
    await expect(new D1FilmRepository(fake.database).findByIds([])).rejects.toThrow(RangeError);
  });

  it('reports a bad batch as a rejected promise, not a synchronous throw', () => {
    // The statement builder validates the batch size synchronously, so without `async` on the
    // repository method the RangeError would escape past a caller's `.catch` and become an
    // unhandled rejection inside a DataLoader. Calling without `await` is the point of this test.
    const fake = createFakeD1();

    expect(() => {
      void new D1FilmRepository(fake.database).findByIds([]).catch(() => undefined);
    }).not.toThrow();
  });
});

describe('D1PersonRepository', () => {
  it('preserves null foreign keys instead of coercing them', async () => {
    const fake = createFakeD1([personRow]);
    const [person] = await new D1PersonRepository(fake.database).list();

    // A character with no recorded species must map to null so the GraphQL field resolves to null,
    // rather than to a string that would be looked up as a real identifier.
    expect(person.speciesId).toBeNull();
    expect(person.homeworldId).toBe('planet-1');
  });

  it('maps the remaining snake_case columns to camelCase', async () => {
    const fake = createFakeD1([personRow]);
    const [person] = await new D1PersonRepository(fake.database).list();

    expect(person.hairColor).toBe('blond');
    expect(person.skinColor).toBe('fair');
    expect(person.eyeColor).toBe('blue');
    expect(person.birthYear).toBe('19BBY');
  });

  it('resolves a planet relation through the homeworld foreign key, not a join table', async () => {
    const fake = createFakeD1();
    await new D1PersonRepository(fake.database).findByPlanetIds(['planet-1']);

    expect(fake.statements[0].sql).toContain('person.homeworld_id');
    expect(fake.statements[0].sql).not.toContain('INNER JOIN');
  });

  it('resolves a film relation through the join table', async () => {
    const fake = createFakeD1();
    await new D1PersonRepository(fake.database).findByFilmIds(['film-1']);

    expect(fake.statements[0].sql).toContain('INNER JOIN film_person');
  });

  it('orders characters by name with a stable tiebreaker', async () => {
    // Two characters can share a name, so the identifier keeps the order deterministic across
    // requests rather than leaving it to the query planner.
    const fake = createFakeD1();
    await new D1PersonRepository(fake.database).list();

    expect(fake.statements[0].sql).toContain('ORDER BY person.name, person.id');
  });
});

describe('D1PlanetRepository', () => {
  it('maps every column of a listed row into the domain shape', async () => {
    const fake = createFakeD1([
      {
        id: 'planet-1',
        name: 'Tatooine',
        rotation_period: '23',
        orbital_period: '304',
        diameter: '10465',
        climate: 'arid',
        gravity: '1 standard',
        terrain: 'desert',
        surface_water: '1',
        population: '200000',
        created: '2014-12-09T13:50:49.641000Z',
        edited: '2014-12-20T20:58:18.411000Z',
        url: 'https://swapi.info/api/planets/1'
      }
    ]);
    const [planet] = await new D1PlanetRepository(fake.database).list();

    expect(planet).toEqual({
      id: 'planet-1',
      name: 'Tatooine',
      rotationPeriod: '23',
      orbitalPeriod: '304',
      diameter: '10465',
      climate: 'arid',
      gravity: '1 standard',
      terrain: 'desert',
      surfaceWater: '1',
      population: '200000',
      created: '2014-12-09T13:50:49.641000Z',
      edited: '2014-12-20T20:58:18.411000Z',
      url: 'https://swapi.info/api/planets/1'
    });
  });
});

describe('createD1Repositories', () => {
  it('provides every port the application tier depends on', () => {
    const fake = createFakeD1();
    const repositories = createD1Repositories(fake.database);

    // The composition root hands this object to the GraphQL context, so a missing port would only
    // surface as a resolver failing at request time.
    expect(Object.keys(repositories).toSorted()).toEqual([
      'films',
      'people',
      'planets',
      'species',
      'starships',
      'vehicles'
    ]);
  });

  it('shares one database handle across every repository', async () => {
    const fake = createFakeD1();
    const repositories = createD1Repositories(fake.database);

    await repositories.films.list();
    await repositories.people.list();

    // Sharing the handle is what lets the request context count every statement the request issues,
    // no matter which repository issued it.
    expect(fake.statements).toHaveLength(2);
  });
});
