import { describe, expect, it } from 'vitest';
import {
  DashboardService,
  FAQ_FRESHNESS_DAYS
} from '../../../src/worker/application/dashboard-service';
import type { Actor } from '../../../src/worker/domain/actor';
import type { DashboardMetrics, DashboardRepository } from '../../../src/worker/domain/dashboard';

const metrics: DashboardMetrics = {
  openCount: 2,
  byProduct: [{ productId: 'd1', openCount: 2 }],
  averageQueueAgeMs: 60_000,
  oldestQueueAgeMs: 120_000,
  averageFirstAnswerMs: 30_000,
  averageResolutionMs: null,
  reassignmentCount: 1,
  rejectionCount: 0,
  staleFaqCount: 1,
  indexingBacklog: 2,
  failedIndexJobs: 1
};

/**
 * Build an actor with only the fields dashboard policy needs.
 */
function actor(role: Actor['role'], productScopes: string[] = ['d1']): Actor {
  return {
    identityKey: 'identity',
    email: 'user@example.com',
    role,
    clearance: 'internal',
    productScopes
  };
}

/**
 * Repository double that records scope without handling content or timestamps.
 */
class RecordingDashboardRepository implements DashboardRepository {
  public call: { productIds: string[] | null; now: string; freshnessDays: number } | null = null;

  /**
   * Record the requested scope and return a stable content-free dashboard.
   */
  public metrics(
    productIds: string[] | null,
    now: string,
    freshnessDays: number
  ): Promise<DashboardMetrics> {
    this.call = { productIds, now, freshnessDays };
    return Promise.resolve(metrics);
  }
}

describe('DashboardService', () => {
  it('limits PM metrics to the current product scope', async () => {
    const repository = new RecordingDashboardRepository();
    await expect(
      new DashboardService(repository).metrics(actor('pm'), new Date('2026-10-15T00:00:00.000Z'))
    ).resolves.toEqual(metrics);
    expect(repository.call).toEqual({
      productIds: ['d1'],
      now: '2026-10-15T00:00:00.000Z',
      freshnessDays: FAQ_FRESHNESS_DAYS
    });
  });

  it('allows an administrator to see every product', async () => {
    const repository = new RecordingDashboardRepository();
    await new DashboardService(repository).metrics(
      actor('administrator', []),
      new Date('2026-10-15T00:00:00.000Z')
    );
    expect(repository.call?.productIds).toBeNull();
  });

  it('does not expose dashboard capability to a salesperson', async () => {
    await expect(
      new DashboardService(new RecordingDashboardRepository()).metrics(
        actor('salesperson'),
        new Date()
      )
    ).rejects.toMatchObject({ problemDetails: { status: 404 } });
  });
});
