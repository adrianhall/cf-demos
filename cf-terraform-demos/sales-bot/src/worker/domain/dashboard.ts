/**
 * A product bucket in the operational dashboard.
 */
export interface ProductDashboardMetric {
  /**
   * Product slug, or `unclassified` when routing has not classified the escalation.
   */
  productId: string;
  /**
   * Number of open or assigned escalations in the bucket.
   */
  openCount: number;
}

/**
 * D1-derived, content-free operational metrics for the web workflow.
 */
export interface DashboardMetrics {
  /**
   * Count of active queue entries.
   */
  openCount: number;
  /**
   * Open work grouped by product.
   */
  byProduct: ProductDashboardMetric[];
  /**
   * Mean age in milliseconds of work that remains open.
   */
  averageQueueAgeMs: number;
  /**
   * Oldest active item age in milliseconds.
   */
  oldestQueueAgeMs: number;
  /**
   * Mean time from escalation opening to its first durable PM answer.
   */
  averageFirstAnswerMs: number | null;
  /**
   * Mean time from escalation opening to rejection or closure.
   */
  averageResolutionMs: number | null;
  /**
   * Reassignments in the selected scope.
   */
  reassignmentCount: number;
  /**
   * Rejections in the selected scope.
   */
  rejectionCount: number;
  /**
   * Active FAQs whose expiry is within the configured freshness window.
   */
  staleFaqCount: number;
  /**
   * Index jobs waiting to be processed.
   */
  indexingBacklog: number;
  /**
   * Index jobs parked after their retry budget.
   */
  failedIndexJobs: number;
}

/**
 * Read port for aggregate dashboard data. Implementations must never return transcript or FAQ text.
 */
export interface DashboardRepository {
  /**
   * Calculate metrics for all products or a caller's scoped products.
   *
   * @param productIds `null` for every product, otherwise the authorized product slugs.
   * @param now Evaluation instant used for age and freshness calculations.
   * @param freshnessDays Number of days before expiry considered stale.
   * @returns Content-free dashboard aggregates.
   * @throws {Error} When authoritative storage cannot complete the read.
   */
  metrics(
    productIds: string[] | null,
    now: string,
    freshnessDays: number
  ): Promise<DashboardMetrics>;
}
