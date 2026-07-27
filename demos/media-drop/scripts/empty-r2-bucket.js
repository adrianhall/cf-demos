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

/**
 * @typedef {object} EmptyR2BucketOptions
 * @property {string} accountId Cloudflare account that owns the bucket.
 * @property {string} apiToken Ordinary deployment token with Workers R2 Storage - Edit permission.
 * @property {string} bucketName Name of the bucket to empty.
 */

/**
 * Empty an R2 bucket through the dashboard-observed API.
 *
 * @param {EmptyR2BucketOptions} options Credentials and target bucket.
 * @returns {Promise<void>} Resolves after Cloudflare accepts the deletion.
 * @throws {Error} When the API rejects or does not confirm the deletion.
 */
export async function emptyR2Bucket({ accountId, apiToken, bucketName }) {
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
}

/**
 * Load local credentials, validate the command-line bucket name, and empty that bucket.
 *
 * @returns {Promise<void>} Resolves after the bucket is empty.
 * @throws {Error} When required input is unavailable or Cloudflare rejects the deletion.
 */
export async function main() {
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

  await emptyR2Bucket({ accountId, apiToken, bucketName });
  console.log(`Emptied R2 bucket ${bucketName}.`);
}

if (import.meta.main) {
  await main();
}
