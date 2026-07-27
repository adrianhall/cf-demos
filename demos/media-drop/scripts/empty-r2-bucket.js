/**
 * Empties an R2 bucket through the dashboard's observed empty-bucket API.
 *
 * The API uses the ordinary Cloudflare deployment token from this demo's `.env`, rather than
 * S3-compatible credentials. The endpoint is not yet documented as a public API contract.
 *
 * @throws {Error} When the bucket argument or required Cloudflare credentials are absent, or
 * Cloudflare rejects the empty-bucket request.
 */
import { resolve } from "node:path";

process.loadEnvFile(resolve(import.meta.dirname, "..", ".env"));

const bucketName = process.argv[2];
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;

if (!bucketName) {
  throw new Error("Usage: node scripts/empty-r2-bucket.js <bucket-name>");
}

if (!accountId || !apiToken) {
  throw new Error(
    ".env must define CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
  );
}

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects?prefix=`,
  {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiToken}`,
    },
  },
);

if (!response.ok) {
  throw new Error(`Empty-bucket API returned HTTP ${response.status}.`);
}

const result = await response.json();
if (result.success !== true) {
  throw new Error("Empty-bucket API returned an unsuccessful response.");
}

console.log(`Emptied R2 bucket ${bucketName}.`);
