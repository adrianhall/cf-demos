import { describe, expect, it } from 'vitest';
import { badRequest, notFound } from '@adrianhall/cloudflare-toolkit/errors';
import {
  SerializedGraphWriter,
  toRejection
} from '../../src/worker/infrastructure/graph-writer.ts';
import { FakeDiagramRepository } from './fake-diagram-repository.ts';

/**
 * @file Covers the persistence half of a live session: the ordering a graph write is held to, and
 *   what a caller is told when one fails. It is a unit suite rather than a runtime one because of
 *   the second of those. A storage failure has no way to be provoked through a real D1 — the
 *   integration suite can delete a row, which covers the "row has gone" path, but not a write that
 *   errors — and that path is exactly where the Phase 16 spike found the consequential bug: a
 *   rejection left on the write chain poisons every later write. Being able to make the repository
 *   fail on demand is what turns that from a comment into an assertion.
 */

const DIAGRAM_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

/**
 * A repository whose writes can be made slow, or made to fail.
 *
 * Extends the shared fake rather than replacing it, so the successful path is the same storage
 * behaviour every other suite asserts against.
 */
class ControllableRepository extends FakeDiagramRepository {
  /**
   * Every graph written, in the order the writes completed. The last entry is what storage holds.
   */
  readonly written: string[] = [];

  /**
   * How long the next writes take, in milliseconds, consumed one per write. An empty queue means no
   * delay.
   */
  readonly delays: number[] = [];

  /**
   * Set to make every write fail, standing in for a storage outage.
   */
  failure: Error | null = null;

  /**
   * Writes a graph, honouring the configured delay and failure.
   *
   * @param id Diagram id.
   * @param graphData Canonical graph JSON.
   * @returns The new timestamp, or `null` when no row has that id.
   * @throws {Error} The configured {@link ControllableRepository.failure}, when one is set.
   */
  override async replaceGraph(id: string, graphData: string): Promise<string | null> {
    // Read on entry, before the delay. A write's fate is decided when it starts, so a test that
    // changes storage's health while this write is in flight affects the *next* write, which is
    // the scenario worth being able to arrange.
    const failure = this.failure;
    const delay = this.delays.shift() ?? 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (failure !== null) {
      throw failure;
    }

    const updatedAt = await super.replaceGraph(id, graphData);
    if (updatedAt !== null) {
      this.written.push(graphData);
    }
    return updatedAt;
  }
}

/**
 * Builds a writer over a controllable repository holding one diagram.
 *
 * @returns The writer and the repository behind it.
 */
async function build(): Promise<{
  writer: SerializedGraphWriter;
  repository: ControllableRepository;
}> {
  const repository = new ControllableRepository();
  const created = await repository.create('alice@example.com', {}, '{}');
  // The fake mints its own id; the writer is bound to that one, since a writer addresses exactly
  // one row by construction.
  return { repository, writer: new SerializedGraphWriter(repository, created.id) };
}

describe('SerializedGraphWriter', () => {
  it('persists a graph and reports what was stored', async () => {
    const { repository, writer } = await build();

    const outcome = await writer.write(() => '{"nodes":[]}', 1);

    expect(outcome).toMatchObject({ graphData: '{"nodes":[]}', outcome: 'applied', sequence: 1 });
    expect(repository.written).toEqual(['{"nodes":[]}']);
  });

  // The guarantee the whole phase rests on, with the adversarial ordering the Phase 16 spike used:
  // a slow write submitted first, a fast one straight after. Unordered, the slow one lands last and
  // restores the older graph.
  it('leaves the later write stored, even when the earlier one is far slower', async () => {
    const { repository, writer } = await build();
    repository.delays.push(50, 0);

    await Promise.all([writer.write(() => 'first', 1), writer.write(() => 'second', 2)]);

    expect(repository.written).toEqual(['first', 'second']);
    expect(repository.written.at(-1)).toBe('second');
  });

  // The second, separate property. A write reads the working graph when its turn arrives, so one
  // that has been waiting stores current state rather than what was current when it was submitted.
  it('stores the graph as it stands when the write’s turn arrives', async () => {
    const { repository, writer } = await build();
    repository.delays.push(30, 0);
    let working = 'a';

    const first = writer.write(() => working, 1);
    const second = writer.write(() => working, 2);
    working = 'c';

    await Promise.all([first, second]);

    expect(repository.written).toEqual(['c', 'c']);
  });

  it('refuses with 404 when the row has gone', async () => {
    const repository = new ControllableRepository();
    const writer = new SerializedGraphWriter(repository, DIAGRAM_ID);

    expect(await writer.write(() => '{}', 1)).toEqual({
      detail: 'Diagram not found.',
      outcome: 'rejected',
      status: 404
    });
  });

  // A failed write must be reported, must not throw — an uncaught exception in a Durable Object
  // discards its in-memory state — and must not disclose the storage error's own text.
  it('reports a failed write as a server fault without leaking its message', async () => {
    const { writer, repository } = await build();
    repository.failure = new Error('D1_ERROR: no such table: diagrams');

    const outcome = await writer.write(() => '{}', 1);

    expect(outcome).toEqual({
      detail: 'The change could not be saved.',
      outcome: 'rejected',
      status: 500
    });
  });

  // The failure the spike found underneath the ordering one, stated as the outcome it produces: a
  // single transient storage error must not make every subsequent edit silently fail to persist.
  it('still persists the next write after one failed', async () => {
    const { writer, repository } = await build();
    repository.failure = new Error('transient');
    await writer.write(() => 'lost', 1);

    repository.failure = null;
    const recovered = await writer.write(() => 'kept', 2);

    expect(recovered).toMatchObject({ graphData: 'kept', outcome: 'applied' });
    expect(repository.written).toEqual(['kept']);
  });

  it('reports a write queued behind a failing one as applied', async () => {
    const { writer, repository } = await build();
    repository.delays.push(20, 0);
    repository.failure = new Error('transient');

    const failing = writer.write(() => 'lost', 1);
    const following = writer.write(() => 'kept', 2);
    // Cleared while the first write is still in flight, so the second finds storage healthy.
    setTimeout(() => {
      repository.failure = null;
    }, 5);

    expect(await failing).toMatchObject({ outcome: 'rejected', status: 500 });
    expect(await following).toMatchObject({ outcome: 'applied' });
  });
});

describe('toRejection', () => {
  // Every domain refusal keeps the status the equivalent REST call answers with, which is what
  // makes an agent and a browser receive the same answer to the same mistake.
  it.each([
    ['a stale target', notFound({ detail: 'Node "ghost" not found.' }), 404],
    ['a duplicate id', badRequest({ detail: 'A node with id "api" already exists.' }), 400]
  ])('keeps the status and detail of %s', (_label, error, status) => {
    expect(toRejection(error)).toMatchObject({ outcome: 'rejected', status });
    expect(toRejection(error).detail).toBe(
      (error as { problemDetails: { detail: string } }).problemDetails.detail
    );
  });

  // The detail reaches a user, and a storage error's own text can name a table, a column or a
  // query. Anything unrecognised therefore gets one fixed message.
  it.each([
    ['a plain error', new Error('D1_ERROR: no such table: diagrams')],
    ['a thrown string', 'something went wrong'],
    ['null', null],
    ['undefined', undefined],
    [
      'a problem-shaped object with a non-numeric status',
      { problemDetails: { detail: 'x', status: '404' } }
    ],
    ['a problem-shaped object with no detail', { problemDetails: { status: 404 } }]
  ])('reports %s as a 500 with a fixed, user-safe message', (_label, error) => {
    expect(toRejection(error)).toEqual({
      detail: 'The change could not be saved.',
      outcome: 'rejected',
      status: 500
    });
  });
});
