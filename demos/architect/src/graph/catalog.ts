import type { ProductId } from "./types";

/** A curated Cloudflare product available in the architecture palette. */
export interface CatalogProduct {
  /** Stable graph identifier, persisted in `ProductNodeData.productId`. */
  id: ProductId;
  /** Palette and node display name. */
  label: string;
  /** Concise capability hint shown on the node and in the palette. */
  description: string;
  /** Visual category shown above the label for users scanning the palette. */
  category: string;
}

/**
 * The demo's curated Cloudflare product catalog.
 *
 * Kept to exactly the five products this demo itself showcases (Workers, D1, R2, KV, and
 * Workflows) rather than every product either prior-art project listed — see
 * `spikes/06-architect-vue-editor/REPORT.md`'s catalog decision, reused verbatim here because
 * this is the same small set of products the demo's own architecture depends on.
 */
export const catalog: readonly CatalogProduct[] = [
  {
    id: "workers",
    label: "Workers",
    description: "Edge application logic",
    category: "Compute",
  },
  {
    id: "d1",
    label: "D1",
    description: "Relational data",
    category: "Storage",
  },
  {
    id: "r2",
    label: "R2",
    description: "Object storage",
    category: "Storage",
  },
  {
    id: "kv",
    label: "Workers KV",
    description: "Global key-value data",
    category: "Storage",
  },
  {
    id: "workflows",
    label: "Workflows",
    description: "Durable orchestration",
    category: "Orchestration",
  },
];

/**
 * Every currently curated product identifier, used to validate persisted graph documents.
 *
 * Typed as `ReadonlySet<string>` (not `ReadonlySet<ProductId>`) so callers validating an
 * untrusted `unknown`/`string` value can call `.has()` directly, without first asserting the
 * candidate is already a {@link ProductId} — see `isProductId` and `../worker/../graph/validation.ts`.
 */
export const catalogProductIds: ReadonlySet<string> = new Set(
  catalog.map((product) => product.id),
);

/**
 * Look up a catalog product by its stable identifier.
 *
 * @param productId Candidate catalog identifier.
 * @returns The matching catalog product.
 * @throws {Error} When `productId` is not one of the curated catalog entries.
 */
export function getProduct(productId: ProductId): CatalogProduct {
  const product = catalog.find((candidate) => candidate.id === productId);
  if (!product) {
    throw new Error(`Unknown catalog product: ${productId}`);
  }
  return product;
}

/**
 * Check whether an untrusted string is one of the curated catalog identifiers.
 *
 * @param value Candidate string, typically from a native drag payload.
 * @returns Whether `value` narrows to {@link ProductId}.
 */
export function isProductId(value: string): value is ProductId {
  return catalogProductIds.has(value);
}
