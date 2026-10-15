import { notFound } from '@adrianhall/cloudflare-toolkit/errors';
import { isAdministrator, type Actor } from '../domain/actor';
import type { DashboardMetrics, DashboardRepository } from '../domain/dashboard';

/**
 * Number of days before an active FAQ is shown as needing review.
 */
export const FAQ_FRESHNESS_DAYS = 14;

/**
 * Authorizes and reads content-free operational aggregates.
 *
 * PMs and overseers are deliberately scoped through the same product map as queue actions. An
 * administrator sees all products; salespeople receive a safe not-found response rather than a
 * discoverable management capability.
 */
export class DashboardService {
  /**
   * @param dashboards Aggregate persistence port.
   */
  public constructor(private readonly dashboards: DashboardRepository) {}

  /**
   * Return dashboard metrics visible to an actor.
   *
   * @param actor Verified actor and current product scopes.
   * @param now One request-scoped evaluation instant.
   * @returns Authorised D1-derived metrics.
   * @throws {ProblemDetailsError} `notFound()` when the actor has no dashboard role.
   * @throws {Error} When D1 cannot compute the aggregates.
   */
  public async metrics(actor: Actor, now: Date): Promise<DashboardMetrics> {
    if (isAdministrator(actor)) {
      return this.dashboards.metrics(null, now.toISOString(), FAQ_FRESHNESS_DAYS);
    }
    if (actor.role !== 'pm' && actor.role !== 'overseer') {
      throw notFound({ detail: 'Dashboard not found.' });
    }
    return this.dashboards.metrics(actor.productScopes, now.toISOString(), FAQ_FRESHNESS_DAYS);
  }
}
