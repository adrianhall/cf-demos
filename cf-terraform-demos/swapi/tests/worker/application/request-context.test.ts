import { describe, expect, it } from 'vitest';
import { createRequestContext } from '../../../src/worker/application/request-context';
import { createFakeD1 } from '../support/fake-d1';

describe('createRequestContext', () => {
  it('starts every request at a zero statement count', () => {
    const fake = createFakeD1();
    expect(createRequestContext(fake.database).countStatements()).toBe(0);
  });

  it('counts a statement issued through any repository', async () => {
    const fake = createFakeD1();
    const context = createRequestContext(fake.database);

    await context.repositories.films.list();

    expect(context.countStatements()).toBe(1);
  });

  it('accumulates statements across different repositories', async () => {
    // The count has to cover the whole request, not one repository: a nested GraphQL query resolves
    // several entity types, and the logged figure is only meaningful if it includes all of them.
    const fake = createFakeD1();
    const context = createRequestContext(fake.database);

    await context.repositories.films.list();
    await context.repositories.people.list();
    await context.repositories.planets.findByIds(['planet-1']);

    expect(context.countStatements()).toBe(3);
  });

  it('isolates counts between contexts, so one request cannot inflate another', async () => {
    // Two contexts over the same database stand in for two concurrent requests in one isolate.
    // A shared counter would make the logged cost of a request depend on unrelated traffic.
    const fake = createFakeD1();
    const first = createRequestContext(fake.database);
    const second = createRequestContext(fake.database);

    await first.repositories.films.list();
    await first.repositories.people.list();
    await second.repositories.films.list();

    expect(first.countStatements()).toBe(2);
    expect(second.countStatements()).toBe(1);
  });

  it('still executes the statements it counts', async () => {
    // The counting wrapper must be transparent: a proxy that dropped the call would report a
    // plausible number while returning no data.
    const fake = createFakeD1([
      {
        id: 'film-1',
        episode_id: '4',
        title: 'A New Hope',
        opening_crawl: 'crawl',
        director: 'George Lucas',
        producer: 'Gary Kurtz',
        release_date: '1977-05-25',
        created: 'created',
        edited: 'edited',
        url: 'https://swapi.info/api/films/1'
      }
    ]);
    const context = createRequestContext(fake.database);

    const films = await context.repositories.films.list();

    expect(films).toHaveLength(1);
    expect(films[0].title).toBe('A New Hope');
    expect(fake.statements[0].sql).toContain('FROM film');
  });

  it('exposes repositories rather than the database itself', () => {
    // The context is what resolvers receive. If it carried the D1 handle, a resolver could issue an
    // uncounted, unbatched query and the architecture's dependency rule would be advisory only.
    const fake = createFakeD1();
    const context = createRequestContext(fake.database);

    expect(context).not.toHaveProperty('DB');
    expect(context).not.toHaveProperty('database');
    expect(Object.keys(context).toSorted()).toEqual(['countStatements', 'repositories']);
  });
});
