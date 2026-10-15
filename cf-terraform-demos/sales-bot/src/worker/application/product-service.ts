import { isAdministrator, type Actor } from '../domain/actor';
import { escalationTargetFor, type Product, type ProductRepository } from '../domain/product';

/**
 * Read access to the product-ownership map.
 *
 * The map is the routing table the escalation workflow will use in Phase 4 and the vocabulary the
 * FAQ editor uses now. It is modelled as its own service rather than folded into
 * {@link import('./faq-service').FaqService} because its lifetime is different: products are seeded
 * and administered, while FAQs are authored, and the authorization rules differ accordingly.
 */
export class ProductService {
  /**
   * @param products Product map persistence port.
   */
  public constructor(private readonly products: ProductRepository) {}

  /**
   * List the products in the map.
   *
   * Readable by every signed-in identity: the map holds product names and the PM display names from
   * the seed CSV, which are neither customer data nor restricted knowledge, and a salesperson needs
   * it to say which product a question is about.
   *
   * Retired products are visible only to an administrator, who needs them when reviewing an FAQ
   * whose product has since been removed from the map.
   *
   * @param actor Resolved authorization subject.
   * @param includeInactive Whether to include retired products.
   * @returns Products ordered by display name.
   * @throws {Error} When the repository rejects the read.
   */
  public async listProducts(actor: Actor, includeInactive: boolean): Promise<Product[]> {
    return this.products.list(includeInactive && isAdministrator(actor));
  }

  /**
   * Resolve the escalation target for a product classification.
   *
   * Provided here, on the service that owns the map, so that Phase 4's escalation workflow routes
   * through the same rule the administrator sees rather than reimplementing the fallback.
   *
   * @param productId Product slug from classification, or `null` when none was determined.
   * @returns The configured escalation target, or the default for an unlisted product.
   * @throws {Error} When the repository rejects the read.
   */
  public async escalationTarget(productId: string | null): Promise<string> {
    const product = productId === null ? null : await this.products.find(productId);
    return escalationTargetFor(product);
  }
}
