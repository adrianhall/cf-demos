/**
 * Fallback escalation target for a product that is not in the seeded map.
 *
 * Named in the product introduction. It is a display name rather than an identity key for the same
 * reason the seeded map is: the CSV records who owns a product, and a deployment maps that person
 * to a verified Cloudflare Access identity during setup.
 */
export const DEFAULT_ESCALATION_TARGET = 'Rita Koslov';

/**
 * One entry in the product-ownership map.
 */
export interface Product {
  /**
   * Stable lowercase slug, used as the foreign key from FAQs and documentation sources.
   */
  id: string;
  /**
   * Display name as written in the seed CSV.
   */
  name: string;
  /**
   * Display name of the owning product manager, or `null` when ownership is unassigned.
   */
  primaryPm: string | null;
  /**
   * Display name this product's escalations go to when the primary PM does not answer, or `null`
   * when the map does not name one.
   */
  escalationTarget: string | null;
  /**
   * Whether the product is currently part of the map. An inactive product keeps its FAQs and
   * history rather than being deleted.
   */
  active: boolean;
}

/**
 * Resolve the escalation target for a product.
 *
 * The specification makes this an application rule rather than a column default, because an
 * unlisted product has no row to carry a default: a question about something that is not in the map
 * still has to reach somebody.
 *
 * @param product Product read from the map, or `null` when the classification named a product that
 *   is not listed.
 * @returns The configured escalation target, or {@link DEFAULT_ESCALATION_TARGET} when the product
 *   is unlisted or names none.
 */
export function escalationTargetFor(product: Product | null): string {
  return product?.escalationTarget ?? DEFAULT_ESCALATION_TARGET;
}

/**
 * Persistence port for the product-ownership map.
 */
export interface ProductRepository {
  /**
   * List every product in the map.
   *
   * @param includeInactive Include products that have been retired from the map.
   * @returns Products ordered by display name.
   * @throws {Error} When the underlying storage rejects the read.
   */
  list(includeInactive: boolean): Promise<Product[]>;

  /**
   * Read one product.
   *
   * @param id Product slug.
   * @returns The product, or `null` when the slug is not in the map.
   * @throws {Error} When the underlying storage rejects the read.
   */
  find(id: string): Promise<Product | null>;

  /**
   * List the product slugs a verified identity manages.
   *
   * Scope is evaluated at action time rather than cached on the identity, because an administrator
   * can change the map between two requests and the second request must use the new map.
   *
   * @param identityKey Verified identity key of the PM or overseer.
   * @param now Instant used to evaluate each scope's effective window.
   * @returns Slugs currently in that identity's scope; empty when they manage nothing.
   * @throws {Error} When the underlying storage rejects the read.
   */
  scopesFor(identityKey: string, now: string): Promise<string[]>;
}
