import { describe, expect, it, vi } from 'vitest';
import type { UserRepository } from '../../src/worker/application/ports/user-repository.ts';
import { UserService } from '../../src/worker/application/user-service.ts';

/**
 * @file Covers the directory use case against a fake port rather than D1. The behaviour that
 *   matters here is not the SQL — the Workers-runtime suite exercises that against a real database
 *   — but the deliberate decision that a directory write never fails the request that triggered
 *   it.
 */

/**
 * An ordinary signed-in identity.
 */
const ALICE = 'alice@example.com';

/**
 * The directory write, which is all {@link UserService} is given.
 *
 * Narrowed here exactly as the service narrows it, so this suite cannot accidentally hand the
 * service a capability production does not: the directory read belongs to the administrative
 * service, behind the administrator check.
 */
type DirectoryWriter = Pick<UserRepository, 'recordSeen'>;

/**
 * Builds an in-memory directory writer whose calls can be inspected.
 *
 * @param overrides Methods to replace; the rest resolve successfully.
 * @returns The fake writer.
 */
function fakeRepository(overrides: Partial<DirectoryWriter> = {}): DirectoryWriter {
  return {
    recordSeen: vi.fn(async () => undefined),
    ...overrides
  };
}

describe('UserService.recordAuthenticatedRequest', () => {
  it('records the identity with the injected clock', async () => {
    const repository = fakeRepository();
    const service = new UserService(repository);

    const recorded = await service.recordAuthenticatedRequest(
      ALICE,
      () => new Date('2026-03-04T05:06:07.000Z')
    );

    expect(recorded).toBe(true);
    expect(repository.recordSeen).toHaveBeenCalledWith(ALICE, '2026-03-04T05:06:07.000Z');
  });

  it('records an ISO-8601 timestamp from the real clock by default', async () => {
    const repository = fakeRepository();

    await new UserService(repository).recordAuthenticatedRequest(ALICE);

    expect(repository.recordSeen).toHaveBeenCalledWith(
      ALICE,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u)
    );
  });

  it('records exactly one write per call', async () => {
    const repository = fakeRepository();

    await new UserService(repository).recordAuthenticatedRequest(ALICE);

    expect(repository.recordSeen).toHaveBeenCalledTimes(1);
  });

  // The property this demo depends on. The directory is a convenience for the administrative view,
  // so a storage failure must not become an outage for every authenticated request — which is
  // exactly what propagating this error out of authentication middleware would cause.
  it('reports failure rather than throwing when the write fails', async () => {
    const service = new UserService(
      fakeRepository({
        recordSeen: vi.fn(async () => {
          throw new Error('D1 unavailable');
        })
      })
    );

    await expect(service.recordAuthenticatedRequest(ALICE)).resolves.toBe(false);
  });

  // Absorbs a non-Error rejection too. A service that only caught `Error` would still take down
  // every authenticated request on a driver that rejects with something else.
  it('reports failure when the write rejects with a non-Error', async () => {
    const service = new UserService(
      fakeRepository({
        recordSeen: vi.fn(() => Promise.reject('storage offline'))
      })
    );

    await expect(service.recordAuthenticatedRequest(ALICE)).resolves.toBe(false);
  });
});
