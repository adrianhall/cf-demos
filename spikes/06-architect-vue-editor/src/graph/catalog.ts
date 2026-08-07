import type { ProductId } from "./types";

/** A small, curated Cloudflare product used to create product nodes. */
export interface CatalogProduct {
  /** Stable graph identifier. */
  id: ProductId;
  /** Palette and node display name. */
  label: string;
  /** Concise capability hint. */
  description: string;
  /** Visual category for users scanning the palette. */
  category: string;
}

/** Exactly five products, intentionally small for the architecture editor demo. */
export const catalog: readonly CatalogProduct[] = [
  { id: "workers", label: "Workers", description: "Edge application logic", category: "Compute" },
  { id: "d1", label: "D1", description: "Relational data", category: "Storage" },
  { id: "r2", label: "R2", description: "Object storage", category: "Storage" },
  { id: "kv", label: "Workers KV", description: "Global key-value data", category: "Storage" },
  { id: "workflows", label: "Workflows", description: "Durable orchestration", category: "Orchestration" },
];

/** Look up a product by its stable identifier. */
export function getProduct(productId: ProductId): CatalogProduct {
  const product = catalog.find((candidate) => candidate.id === productId);
  if (!product) throw new Error(`Unknown catalog product: ${productId}`);
  return product;
}
