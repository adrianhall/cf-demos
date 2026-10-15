import type { Product, ProductRepository } from '../domain/product';

/**
 * Columns selected for every product read.
 */
const PRODUCT_COLUMNS = 'id, name, primary_pm, escalation_target, active';

/**
 * Raw snake_cased product row as stored in D1.
 */
interface ProductRow {
  /**
   * Product slug.
   */
  id: string;
  /**
   * Display name.
   */
  name: string;
  /**
   * Owning PM's display name, or `null`.
   */
  primary_pm: string | null;
  /**
   * Escalation target's display name, or `null`.
   */
  escalation_target: string | null;
  /**
   * Active flag as `0` or `1`; SQLite has no boolean type.
   */
  active: number;
}

/**
 * Convert a stored row into the domain representation.
 *
 * @param row Row returned by a query using {@link PRODUCT_COLUMNS}.
 * @returns The equivalent domain product.
 */
function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    primaryPm: row.primary_pm,
    escalationTarget: row.escalation_target,
    active: row.active === 1
  };
}

/**
 * D1 implementation of the {@link ProductRepository} port.
 *
 * The product map is read on nearly every authorized operation, because a PM's scope is evaluated
 * at action time rather than cached on their identity. That makes the read frequency high and the
 * data tiny — a combination KV would also serve, except that scope is a join between identities,
 * products, and an effective time window, which is exactly what KV cannot express.
 */
export class D1ProductRepository implements ProductRepository {
  /**
   * @param database D1 database bound to this Worker.
   */
  public constructor(private readonly database: Pick<D1Database, 'prepare'>) {}

  /**
   * List every product in the map.
   *
   * @param includeInactive Include products retired from the map.
   * @returns Products ordered by display name.
   * @throws {Error} When D1 rejects the query.
   */
  public async list(includeInactive: boolean): Promise<Product[]> {
    const result = await this.database
      .prepare(
        `SELECT ${PRODUCT_COLUMNS} FROM products ${includeInactive ? '' : 'WHERE active = 1 '}`
          + 'ORDER BY name ASC'
      )
      .all<ProductRow>();
    return result.results.map(toProduct);
  }

  /**
   * Read one product.
   *
   * @param id Product slug.
   * @returns The product, or `null` when the slug is unknown.
   * @throws {Error} When D1 rejects the query.
   */
  public async find(id: string): Promise<Product | null> {
    const row = await this.database
      .prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<ProductRow>();
    return row === null ? null : toProduct(row);
  }

  /**
   * List the product slugs a verified identity currently manages.
   *
   * The effective window is evaluated in SQL rather than in the Worker so a scope that has not
   * started, or has already ended, never becomes a value the application could accidentally use.
   *
   * @param identityKey Verified identity key.
   * @param now ISO-8601 instant used to evaluate the window.
   * @returns Slugs currently in scope; empty when the identity manages nothing.
   * @throws {Error} When D1 rejects the query.
   */
  public async scopesFor(identityKey: string, now: string): Promise<string[]> {
    const result = await this.database
      .prepare(
        'SELECT product_id FROM product_scopes WHERE identity_key = ? AND effective_from <= ? '
          + 'AND (effective_to IS NULL OR effective_to > ?)'
      )
      .bind(identityKey, now, now)
      .all<{ product_id: string }>();
    return result.results.map((row) => row.product_id);
  }
}
