/**
 * @file Server-side search, exercised against the real migrated dataset in the Workers runtime. The
 *   statement-construction unit tests in `../worker/infrastructure/sql.test.ts` prove the SQL is
 *   shaped correctly; these prove it actually selects the right rows from D1, which is the part a
 *   string comparison cannot establish. Case folding, substring matching, wildcard escaping, and
 *   the choice of searchable columns are all properties of the database rather than of the text.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createRequestContext } from '../../src/worker/application/request-context';

/**
 * Build repositories over the migrated test database.
 *
 * @returns The six repository ports, wired to D1 exactly as a request would wire them.
 */
function repositories() {
  return createRequestContext(env.DB).repositories;
}

describe('collection search', () => {
  it('matches a substring rather than only a prefix', async () => {
    const people = await repositories().people.list('walker');

    expect(people.map((person) => person.name)).toContain('Luke Skywalker');
  });

  it('is case-insensitive in both directions', async () => {
    const lower = await repositories().people.list('luke');
    const upper = await repositories().people.list('LUKE');

    expect(lower.map((person) => person.name)).toContain('Luke Skywalker');
    expect(upper).toEqual(lower);
  });

  it('returns an empty list rather than failing when nothing matches', async () => {
    await expect(repositories().people.list('zzzznosuchperson')).resolves.toEqual([]);
  });

  it('preserves the collection ordering of the unfiltered list', async () => {
    const matches = await repositories().planets.list('a');
    const names = matches.map((planet) => planet.name);

    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('treats an absent term as the whole collection', async () => {
    const [all, unfiltered] = await Promise.all([
      repositories().films.list(),
      repositories().films.list(undefined)
    ]);

    expect(all).toHaveLength(6);
    expect(unfiltered).toEqual(all);
  });

  // Searching films by title is the primary case; `name` does not exist on this type, which is
  // exactly the asymmetry the per-type searchable-column lists exist to handle.
  it('searches films by title', async () => {
    const films = await repositories().films.list('hope');

    expect(films.map((film) => film.title)).toEqual(['A New Hope']);
  });

  it('searches starships by model as well as name', async () => {
    const byName = await repositories().starships.list('X-wing');
    const byModel = await repositories().starships.list('T-65');

    expect(byName.map((starship) => starship.name)).toContain('X-wing');
    expect(byModel.map((starship) => starship.name)).toContain('X-wing');
  });

  it('searches planets by climate, not only by name', async () => {
    const planets = await repositories().planets.list('desert');

    expect(planets.map((planet) => planet.name)).toContain('Tatooine');
  });

  // Provenance columns must not be searchable: every row carries a `swapi.info` URL and a 2014
  // timestamp, so matching either would return the entire collection for a term the user cannot
  // connect to any visible field.
  it.each([
    ['a URL fragment', 'swapi.info'],
    ['a timestamp fragment', '2014-12']
  ])('does not match %s', async (_label, term) => {
    await expect(repositories().people.list(term)).resolves.toEqual([]);
  });

  it('does not match an identifier', async () => {
    const [first] = await repositories().people.list();
    expect(first).toBeDefined();

    await expect(repositories().people.list(first!.id)).resolves.toEqual([]);
  });

  // A bare `%` reaching LIKE unescaped would match every row. This is the wildcard-escaping
  // behaviour of `searchPattern`, observed through the database rather than asserted about a
  // string.
  it.each([
    ['percent', '%'],
    ['underscore', '_'],
    ['backslash', '\\']
  ])('treats a %s in the term as a literal character', async (_label, term) => {
    await expect(repositories().people.list(term)).resolves.toEqual([]);
  });

  it('runs one statement per searched collection', async () => {
    const context = createRequestContext(env.DB);

    await context.repositories.people.list('a');

    expect(context.countStatements()).toBe(1);
  });
});
