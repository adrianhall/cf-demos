#!/usr/bin/env node
/**
 * Generates a local-only `wrangler.jsonc` from the Terraform template.
 *
 * @returns {void}
 * @throws {Error} When the template contains a placeholder without a local value.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = resolve(rootDir, "wrangler.jsonc.tpl");
const outputPath = resolve(rootDir, "wrangler.jsonc");

/** Local substitutes for every Terraform-derived template marker. */
const localPlaceholderValues = {
  cloudflare_team_domain: "local.cloudflareaccess.com",
  d1_database_id: "00000000-0000-0000-0000-000000000000",
  d1_database_name: "media-drop-local",
  environment: "development",
  r2_bucket_name: "media-drop-local",
  worker_name: "media-drop-local",
};

/**
 * Replaces each template marker with its local value.
 *
 * @param {string} template - Raw template contents.
 * @returns {string} The fully substituted Wrangler configuration.
 * @throws {Error} When a marker has no configured local replacement.
 */
function substitute(template) {
  return template.replace(/\{\{(\w+)\}\}/g, (marker, name) => {
    if (!Object.hasOwn(localPlaceholderValues, name)) {
      throw new Error(
        `No local value configured for Wrangler template marker ${marker}.`,
      );
    }
    return localPlaceholderValues[name];
  });
}

if (!existsSync(outputPath)) {
  writeFileSync(outputPath, substitute(readFileSync(templatePath, "utf8")));
}
