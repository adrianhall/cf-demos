/**
 * @file Proves the claim this demo is built to make: that a nested GraphQL query costs a bounded
 *   number of D1 statements rather than one per row. The other suites check that queries return the
 *   right data, which an N+1 implementation would also do — just slowly. These tests instead count
 *   the statements a query issues, by running the GraphQL schema directly against a counting
 *   request context rather than through HTTP. That is the only way to observe the number the Worker
 *   logs, and it is what would fail if a future resolver were written to fetch one row at a time.
 */

import { env } from 'cloudflare:workers';
import { execute, parse } from 'graphql';
import { describe, expect, it } from 'vitest';
import { schema } from '../../src/worker/application/graphql/schema';
import { createRequestContext } from '../../src/worker/application/request-context';

/**
 * Execute a query against the real migrated database and report its statement cost.
 *
 * @param query GraphQL document to execute.
 * @returns The execution result and the number of D1 statements it issued.
 * @throws {Error} When the document fails to parse.
 */
async function measure(query: string): Promise<{ data: unknown; statements: number }> {
  const context = createRequestContext(env.DB);
  const result = await execute({
    schema,
    document: parse(query),
    contextValue: context
  });

  expect(result.errors, 'query should execute without errors').toBeUndefined();
  return { data: result.data, statements: context.countStatements() };
}

describe('statement batching', () => {
  it('reads a single collection in one statement', async () => {
    const { statements } = await measure('{ films { title } }');

    expect(statements).toBe(1);
  });

  it('adds one statement per relation, not one per parent row', async () => {
    // Six films, each with many characters. An N+1 implementation would issue seven statements
    // here: one for the films and one per film. Batched, it is two.
    const { data, statements } = await measure('{ films { title characters { name } } }');
    const films = (data as { films: { characters: unknown[] }[] }).films;

    expect(films).toHaveLength(6);
    expect(statements).toBe(2);
  });

  it('keeps a three-level traversal at one statement per relation', async () => {
    // films → characters → homeworld. Naively this is one statement for the films, six for their
    // characters, and one per character for the homeworlds — well over a hundred. Batched, it is
    // three, regardless of how many rows are involved.
    const { statements } = await measure(`{
      films { title characters { name homeworld { name } } }
    }`);

    expect(statements).toBe(3);
  });

  it('scales with relations selected rather than with rows returned', async () => {
    // Every character in the dataset, each with their homeworld: still two statements. This is the
    // clearest statement of the property — the row count is large and the statement count is not.
    const { data, statements } = await measure('{ people { name homeworld { name } } }');
    const people = (data as { people: unknown[] }).people;

    expect(people.length).toBeGreaterThan(50);
    expect(statements).toBe(2);
  });

  it('reads two independent collections in one statement each', async () => {
    const { statements } = await measure('{ films { title } people { name } }');

    expect(statements).toBe(2);
  });

  it('issues one statement per distinct relation on the same parent', async () => {
    // Five relations on one collection: one statement for the films plus one for each relation.
    const { statements } = await measure(`{
      films {
        title
        characters { name }
        planets { name }
        species { name }
        starships { name }
        vehicles { name }
      }
    }`);

    expect(statements).toBe(6);
  });

  it('batches a by-identifier lookup repeated within one query', async () => {
    const list = await measure('{ films { id } }');
    const [first, second] = (list.data as { films: { id: string }[] }).films;

    // Two aliased lookups of the same field resolve through one loader, so this is one statement
    // rather than two.
    const { statements } = await measure(`{
      a: film(id: "${first.id}") { title }
      b: film(id: "${second.id}") { title }
    }`);

    expect(statements).toBe(1);
  });

  it('does not query for a relation that was not selected', async () => {
    // Relations are resolved on demand, so a query asking only for scalars pays only for them.
    const { statements } = await measure('{ films { title director } }');

    expect(statements).toBe(1);
  });

  it('keeps a limited relation to one statement', async () => {
    // The per-parent limit is pushed into SQL as a window function, so limiting does not turn one
    // batched query back into one query per parent.
    const { statements } = await measure('{ films { characters(first: 3) { name } } }');

    expect(statements).toBe(2);
  });

  it('resolves both directions of a relation in one statement each', async () => {
    const { statements } = await measure(`{
      planets { name residents { name } }
    }`);

    expect(statements).toBe(2);
  });
});
