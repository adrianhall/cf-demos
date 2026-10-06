import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

/**
 * Test-only bindings injected by the integration Vitest project (`./vitest.config.ts`).
 */
interface TestEnv extends Env {
  /**
   * Parsed D1 migrations used to build the schema in Miniflare's otherwise empty database.
   */
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}

/**
 * Audience the Worker is configured to accept, matching `ACCESS_AUD` in `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

const testEnv = env as TestEnv;

/**
 * Build a request carrying a development Access JWT for one identity.
 *
 * @param email Identity to sign the token for.
 * @param path API path to request.
 * @param init Additional request options; a JSON content type is added when a body is present.
 * @param audience Audience to mint the token for. Defaults to the audience the Worker accepts; a
 *   test overrides it to prove cross-application tokens are refused.
 * @returns A request ready to dispatch through the Worker.
 */
async function requestAs(
  email: string,
  path: string,
  init: RequestInit = {},
  audience: string = AUD
): Promise<Request> {
  const token = await signDevJwt(email, { audience });
  const headers = new Headers(init.headers);
  headers.set(JWT_HEADER, token);
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  return new Request(`https://todo.example${path}`, { ...init, headers });
}

/**
 * Dispatch a request through the Worker under test.
 *
 * @param request Request to dispatch.
 * @returns The Worker's response.
 */
async function send(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

/**
 * Create a task as one identity and return it.
 *
 * @param email Identity that will own the task.
 * @param title Task title to submit.
 * @returns The created task's identifier and title.
 */
async function createTask(email: string, title: string): Promise<{ id: string; title: string }> {
  const response = await send(
    await requestAs(email, '/api/todos', { body: JSON.stringify({ title }), method: 'POST' })
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { todo: { id: string; title: string } };
  return body.todo;
}

/**
 * Waits long enough for two consecutively created tasks to receive distinct `created_at` values.
 *
 * `created_at` is an ISO-8601 string, so its resolution is one millisecond, and the list query
 * breaks a tie on `id` — which is a random UUID. Two tasks created inside the same millisecond
 * therefore come back in an arbitrary order, and the ordering assertion below fails roughly half
 * the time that happens. Measured in this runtime, an ordinary `await` boundary leaves the two
 * creates inside the same millisecond about 3% of the time, which made the failure look like
 * unexplained flakiness rather than a timing collision.
 *
 * Twenty milliseconds rather than the one millisecond strictly required: the margin costs nothing
 * in a suite that already performs HTTP round trips, and a one-millisecond sleep would sit exactly
 * on the boundary it is meant to clear.
 *
 * This is a deliberate test-only accommodation of a product behaviour, not a fix for it. A user who
 * creates two tasks within the same millisecond still sees them in an arbitrary order; making that
 * impossible needs a monotonic tiebreaker in the schema, which both chat demos already have by
 * ordering on an integer key.
 *
 * @returns A promise that settles once the clock has certainly advanced past the current
 *   millisecond.
 */
async function waitForDistinctTimestamp(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * List one identity's tasks.
 *
 * @param email Identity whose tasks are listed.
 * @returns That identity's tasks.
 */
async function listTasks(email: string): Promise<{ id: string; title: string }[]> {
  const response = await send(await requestAs(email, '/api/todos'));
  expect(response.status).toBe(200);
  return ((await response.json()) as { todos: { id: string; title: string }[] }).todos;
}

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const MISSING_ID = '5d837139-c37f-4fe3-b95c-69757a3a823d';

describe('Tasks Worker', () => {
  beforeAll(async () => {
    // Builds the schema from the real migration SQL, so a broken migration fails these tests
    // rather than only failing a deploy.
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  });

  beforeEach(async () => {
    await testEnv.DB.prepare('DELETE FROM todos').run();
  });

  describe('authentication', () => {
    it.each([
      ['GET', '/api/me'],
      ['GET', '/api/todos'],
      ['POST', '/api/todos'],
      ['PATCH', `/api/todos/${MISSING_ID}`],
      ['DELETE', '/api/todos/completed'],
      ['DELETE', `/api/todos/${MISSING_ID}`]
    ])('rejects an unauthenticated %s %s with 401', async (method, path) => {
      const response = await send(new Request(`https://todo.example${path}`, { method }));
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    // Every Access application in a team shares one JWKS, so a correctly signed token minted for a
    // different application would pass signature validation. The audience check is what stops it.
    it('rejects a valid token minted for a different Access application', async () => {
      const response = await send(await requestAs(ALICE, '/api/todos', {}, 'b'.repeat(64)));
      expect(response.status).toBe(401);
    });

    it('accepts a token for the configured audience', async () => {
      const response = await send(await requestAs(ALICE, '/api/me'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ email: ALICE });
    });

    // There is no anonymous surface: unlike the sibling `link` demo, no path bypasses Access.
    it('has no public route', async () => {
      const response = await send(new Request('https://todo.example/api/todos'));
      expect(response.status).toBe(401);
    });
  });

  describe('task lifecycle', () => {
    it('creates, lists, renames, completes, and deletes a task', async () => {
      const created = await createTask(ALICE, 'Buy milk');
      expect(created.title).toBe('Buy milk');

      expect(await listTasks(ALICE)).toHaveLength(1);

      const renamed = await send(
        await requestAs(ALICE, `/api/todos/${created.id}`, {
          body: JSON.stringify({ title: 'Buy oat milk' }),
          method: 'PATCH'
        })
      );
      expect(renamed.status).toBe(200);
      expect(((await renamed.json()) as { todo: { title: string } }).todo.title).toBe(
        'Buy oat milk'
      );

      const completed = await send(
        await requestAs(ALICE, `/api/todos/${created.id}`, {
          body: JSON.stringify({ completed: true }),
          method: 'PATCH'
        })
      );
      expect(((await completed.json()) as { todo: { completed: boolean } }).todo.completed).toBe(
        true
      );

      const deleted = await send(
        await requestAs(ALICE, `/api/todos/${created.id}`, { method: 'DELETE' })
      );
      expect(deleted.status).toBe(204);
      expect(await listTasks(ALICE)).toHaveLength(0);
    });

    it('clears only completed tasks', async () => {
      const done = await createTask(ALICE, 'Done task');
      await createTask(ALICE, 'Pending task');
      await send(
        await requestAs(ALICE, `/api/todos/${done.id}`, {
          body: JSON.stringify({ completed: true }),
          method: 'PATCH'
        })
      );

      const response = await send(
        await requestAs(ALICE, '/api/todos/completed', { method: 'DELETE' })
      );
      expect(response.status).toBe(204);

      const remaining = await listTasks(ALICE);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.title).toBe('Pending task');
    });

    it('lists newest first', async () => {
      await createTask(ALICE, 'First');
      // Without this the two tasks can share a `created_at` millisecond, and the tie is broken on
      // a random UUID. See waitForDistinctTimestamp().
      await waitForDistinctTimestamp();
      await createTask(ALICE, 'Second');

      expect((await listTasks(ALICE)).map((task) => task.title)).toEqual(['Second', 'First']);
    });
  });

  // The behaviour this demo exists to teach: all users' rows share one table, and isolation comes
  // from the SQL predicate rather than from separate storage.
  describe('per-user isolation', () => {
    it("does not show one user another user's tasks", async () => {
      await createTask(ALICE, "Alice's task");

      expect(await listTasks(BOB)).toEqual([]);
      expect(await listTasks(ALICE)).toHaveLength(1);
    });

    it("reports another user's task as not found rather than forbidden", async () => {
      const alices = await createTask(ALICE, "Alice's task");

      // 404 rather than 403: a 403 would confirm the identifier exists.
      const read = await send(
        await requestAs(BOB, `/api/todos/${alices.id}`, {
          body: JSON.stringify({ completed: true }),
          method: 'PATCH'
        })
      );
      expect(read.status).toBe(404);
    });

    it("cannot delete another user's task", async () => {
      const alices = await createTask(ALICE, "Alice's task");

      const response = await send(
        await requestAs(BOB, `/api/todos/${alices.id}`, { method: 'DELETE' })
      );
      expect(response.status).toBe(404);
      expect(await listTasks(ALICE)).toHaveLength(1);
    });

    it("cannot clear another user's completed tasks", async () => {
      const alices = await createTask(ALICE, "Alice's task");
      await send(
        await requestAs(ALICE, `/api/todos/${alices.id}`, {
          body: JSON.stringify({ completed: true }),
          method: 'PATCH'
        })
      );

      await send(await requestAs(BOB, '/api/todos/completed', { method: 'DELETE' }));

      expect(await listTasks(ALICE)).toHaveLength(1);
    });

    it("stores every user's rows in one table, separated by user_id", async () => {
      await createTask(ALICE, "Alice's task");
      await createTask(BOB, "Bob's task");

      const rows = await testEnv.DB.prepare('SELECT user_id FROM todos ORDER BY user_id').all<{
        user_id: string;
      }>();
      expect(rows.results.map((row) => row.user_id)).toEqual([ALICE, BOB]);
    });
  });

  describe('validation', () => {
    it.each([
      ['an empty title', { title: '' }, 422],
      ['a missing title', {}, 422],
      ['a non-string title', { title: 42 }, 422],
      ['an over-long title', { title: 'a'.repeat(281) }, 422],
      ['an unexpected field', { title: 'ok', completed: true }, 422]
    ])('rejects %s on create with %i', async (_label, body, status) => {
      const response = await send(
        await requestAs(ALICE, '/api/todos', { body: JSON.stringify(body), method: 'POST' })
      );
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });

    it('rejects malformed JSON with 400', async () => {
      const response = await send(
        await requestAs(ALICE, '/api/todos', { body: '{"title":', method: 'POST' })
      );
      expect(response.status).toBe(400);
    });

    it('trims the stored title', async () => {
      const created = await createTask(ALICE, '  Padded  ');
      expect(created.title).toBe('Padded');
    });

    it('rejects an empty update with 422', async () => {
      const created = await createTask(ALICE, 'Buy milk');
      const response = await send(
        await requestAs(ALICE, `/api/todos/${created.id}`, {
          body: JSON.stringify({}),
          method: 'PATCH'
        })
      );
      expect(response.status).toBe(422);
    });

    it.each(['not-a-uuid', '12345'])('answers a malformed id %s with 404', async (id) => {
      const response = await send(await requestAs(ALICE, `/api/todos/${id}`, { method: 'DELETE' }));
      expect(response.status).toBe(404);
    });

    it('answers an unknown but well-formed id with 404', async () => {
      const response = await send(
        await requestAs(ALICE, `/api/todos/${MISSING_ID}`, { method: 'DELETE' })
      );
      expect(response.status).toBe(404);
    });
  });

  describe('error shape', () => {
    it('returns RFC 9457 problem details without a stack trace', async () => {
      const response = await send(
        await requestAs(ALICE, '/api/todos', {
          body: JSON.stringify({ title: '' }),
          method: 'POST'
        })
      );
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ status: 422 });
      expect(body).not.toHaveProperty('stack');
    });

    it('answers an unknown API route with a 404 problem document', async () => {
      const response = await send(await requestAs(ALICE, '/api/nope'));
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    });
  });
});
