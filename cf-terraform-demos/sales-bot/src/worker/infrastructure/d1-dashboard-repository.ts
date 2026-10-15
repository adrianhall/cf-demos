import type {
  DashboardMetrics,
  DashboardRepository,
  ProductDashboardMetric
} from '../domain/dashboard';

interface CountRow {
  count: number;
}
interface NumberRow {
  value: number | null;
}
interface ProductRow {
  product_id: string | null;
  count: number;
}

/**
 * D1 implementation of content-free dashboard aggregates.
 *
 * All escalation measures use escalation lifecycle timestamps, not conversation events. A retry of
 * a web frame therefore cannot inflate volume, response, or resolution measures.
 */
export class D1DashboardRepository implements DashboardRepository {
  /**
   * @param database Authoritative D1 binding.
   */
  public constructor(private readonly database: D1Database) {}

  /**
   * Calculate one caller-scoped dashboard snapshot.
   *
   * @param productIds `null` for all products, otherwise scope slugs.
   * @param now Evaluation instant for queue age and FAQ freshness.
   * @param freshnessDays Expiry horizon for stale FAQs.
   * @returns Content-free aggregate metrics.
   * @throws {Error} When D1 rejects an aggregate query.
   */
  public async metrics(
    productIds: string[] | null,
    now: string,
    freshnessDays: number
  ): Promise<DashboardMetrics> {
    if (productIds !== null && productIds.length === 0) return this.empty();
    const scope = this.scope(productIds);
    const active = "status IN ('open', 'assigned')";
    const [
      open,
      products,
      ages,
      firstAnswer,
      resolution,
      reassignments,
      rejections,
      stale,
      backlog,
      failed
    ] = await Promise.all([
      this.count(
        `SELECT COUNT(*) AS count FROM escalations ${scope.where(active)}`,
        scope.parameters
      ),
      this.products(scope, active),
      this.database
        .prepare(
          `SELECT AVG(MAX(0, (julianday(?) - julianday(opened_at)) * 86400000)) AS value, MAX(MAX(0, (julianday(?) - julianday(opened_at)) * 86400000)) AS oldest FROM escalations ${scope.where(active)}`
        )
        .bind(now, now, ...scope.parameters)
        .first<{ value: number | null; oldest: number | null }>(),
      this.average(scope, 'answered_at IS NOT NULL', 'answered_at'),
      this.average(scope, 'closed_at IS NOT NULL', 'closed_at'),
      this.count(
        `SELECT COUNT(*) AS count FROM escalation_assignments ${scope.assignmentWhere()}`,
        scope.parameters
      ),
      this.count(
        `SELECT COUNT(*) AS count FROM escalations ${scope.where("status = 'rejected'")}`,
        scope.parameters
      ),
      this.count(
        `SELECT COUNT(*) AS count FROM faqs ${scope.faqWhere("status = 'active' AND expires_at IS NOT NULL AND expires_at >= ? AND expires_at <= datetime(?, '+' || ? || ' days')")}`,
        [...scope.parameters, now, now, freshnessDays]
      ),
      this.count(
        `SELECT COUNT(*) AS count FROM faq_index_jobs AS jobs JOIN faqs AS faq ON faq.id = jobs.faq_id AND faq.revision = jobs.faq_revision ${scope.faqWhere("jobs.status = 'pending'", 'faq')}`,
        scope.parameters
      ),
      this.count(
        `SELECT COUNT(*) AS count FROM faq_index_jobs AS jobs JOIN faqs AS faq ON faq.id = jobs.faq_id AND faq.revision = jobs.faq_revision ${scope.faqWhere("jobs.status = 'failed'", 'faq')}`,
        scope.parameters
      )
    ]);
    return {
      openCount: open,
      byProduct: products,
      averageQueueAgeMs: Math.round(ages?.value ?? 0),
      oldestQueueAgeMs: Math.round(ages?.oldest ?? 0),
      averageFirstAnswerMs: firstAnswer,
      averageResolutionMs: resolution,
      reassignmentCount: reassignments,
      rejectionCount: rejections,
      staleFaqCount: stale,
      indexingBacklog: backlog,
      failedIndexJobs: failed
    };
  }

  private async products(scope: Scope, active: string): Promise<ProductDashboardMetric[]> {
    const result = await this.database
      .prepare(
        `SELECT product_id, COUNT(*) AS count FROM escalations ${scope.where(active)} GROUP BY product_id ORDER BY count DESC, product_id ASC`
      )
      .bind(...scope.parameters)
      .all<ProductRow>();
    return result.results.map((row) => ({
      productId: row.product_id ?? 'unclassified',
      openCount: row.count
    }));
  }

  private async average(
    scope: Scope,
    condition: string,
    endColumn: string
  ): Promise<number | null> {
    const row = await this.database
      .prepare(
        `SELECT AVG(MAX(0, (julianday(${endColumn}) - julianday(opened_at)) * 86400000)) AS value FROM escalations ${scope.where(condition)}`
      )
      .bind(...scope.parameters)
      .first<NumberRow>();
    return row?.value === null || row?.value === undefined ? null : Math.round(row.value);
  }

  private async count(statement: string, parameters: unknown[]): Promise<number> {
    const row = await this.database
      .prepare(statement)
      .bind(...parameters)
      .first<CountRow>();
    return row?.count ?? 0;
  }

  private scope(productIds: string[] | null): Scope {
    return new Scope(productIds);
  }

  private empty(): DashboardMetrics {
    return {
      openCount: 0,
      byProduct: [],
      averageQueueAgeMs: 0,
      oldestQueueAgeMs: 0,
      averageFirstAnswerMs: null,
      averageResolutionMs: null,
      reassignmentCount: 0,
      rejectionCount: 0,
      staleFaqCount: 0,
      indexingBacklog: 0,
      failedIndexJobs: 0
    };
  }
}

/**
 * Builds parameterized scope clauses shared by dashboard queries.
 */
class Scope {
  /**
   * Query bind values for a non-administrator product scope.
   */
  public readonly parameters: string[];
  private readonly clause: string;

  /**
   * @param productIds `null` for all products, otherwise authorized products.
   */
  public constructor(productIds: string[] | null) {
    this.parameters = productIds ?? [];
    this.clause =
      productIds === null ? '' : `product_id IN (${productIds.map(() => '?').join(', ')})`;
  }

  /**
   * @param condition Additional constrained condition. @returns Escalation where clause.
   */
  public where(condition: string): string {
    return `WHERE ${[this.clause, condition].filter(Boolean).join(' AND ')}`;
  }

  /**
   * @returns Assignment query scope via the authoritative escalation product.
   */
  public assignmentWhere(): string {
    return this.clause === ''
      ? ''
      : `WHERE escalation_id IN (SELECT id FROM escalations WHERE ${this.clause})`;
  }

  /**
   * @param condition Additional FAQ condition.
   * @param table Optional FAQ table alias.
   * @returns FAQ where clause with the equivalent product scope.
   */
  public faqWhere(condition: string, table: string = ''): string {
    const product = table === '' ? 'product_id' : `${table}.product_id`;
    const scoped =
      this.clause === '' ? '' : `${product} IN (${this.parameters.map(() => '?').join(', ')})`;
    return `WHERE ${[scoped, condition].filter(Boolean).join(' AND ')}`;
  }
}
