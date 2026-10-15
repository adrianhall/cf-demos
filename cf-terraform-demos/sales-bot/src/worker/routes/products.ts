import { Hono } from 'hono';
import type { AppBindings } from '../bindings';

/**
 * Product-map API, mounted at `/api/products`.
 *
 * Read-only in Phase 2. The map is seeded by migration and is what the FAQ editor's product
 * selector and the escalation routing in Phase 4 both read. Editing it is an administrator
 * operation that arrives with the escalation workflow, because the useful edits — reassigning
 * ownership, changing an escalation target — only have observable consequences once escalations
 * exist.
 */
export const productsRouter = new Hono<AppBindings>();

/**
 * List the products in the map.
 *
 * Every signed-in identity may read it. The map contains no customer data and no restricted
 * knowledge — it is a list of product names and the PM display names from the seed CSV — and a
 * salesperson needs it to tell which product their question is about.
 *
 * `?includeInactive=true` additionally returns products retired from the map, which an
 * administrator needs when reviewing an older FAQ whose product is no longer current.
 *
 * @param context Hono request context providing the product service.
 * @returns A JSON `200` response containing the products, ordered by display name.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {Error} When the repository cannot list the products.
 */
productsRouter.get('/', async (context) => {
  const includeInactive = context.req.query('includeInactive') === 'true';
  return context.json({
    products: await context
      .get('PRODUCT_SERVICE')
      .listProducts(context.get('ACTOR'), includeInactive)
  });
});
