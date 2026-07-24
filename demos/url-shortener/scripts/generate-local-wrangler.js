#!/usr/bin/env node
/**
 * Generates a local-only `wrangler.jsonc` from `wrangler.jsonc.tpl`, filling the same
 * `{{placeholder}}` markers `generate-wrangler` (`@adrianhall/cloudflare-scripts`) fills
 * from real Terraform outputs with fixed local-development values instead.
 *
 * Does nothing but exit `0` if `wrangler.jsonc` already exists — a real
 * Terraform-generated config from `npm run deploy` (or a config this script already
 * wrote) is never overwritten. This lets `dev`, `build`, `check:types`, and the
 * integration tests all point at one `wrangler.jsonc` (see `tests/integration/vitest.config.ts`)
 * from a clean checkout, without requiring Terraform to have run first.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = resolve(rootDir, "wrangler.jsonc.tpl");
const outputPath = resolve(rootDir, "wrangler.jsonc");

/**
 * Local-development value for every `{{placeholder}}` marker in `wrangler.jsonc.tpl`.
 * These match this demo's previous committed `wrangler.local.jsonc`, so generated local
 * behavior (Worker name, Access team domain, KV namespace id, `ENVIRONMENT`) is unchanged
 * from before that file was replaced by this generated fallback.
 */
const LOCAL_PLACEHOLDER_VALUES = {
  // Matches `.env.example`'s `ADMIN_EMAIL` default and the dev-JWT email every test and the
  // local Access login flow use, so a clean local checkout resolves as the demo administrator.
  admin_email: "admin@example.com",
  cloudflare_team_domain: "local.cloudflareaccess.com",
  environment: "development",
  links_kv_namespace_id: "00000000000000000000000000000000",
  worker_name: "url-shortener-local",
};

/**
 * Replace every `{{name}}` marker in `template` with its configured local value.
 *
 * @param {string} template Raw contents of `wrangler.jsonc.tpl`.
 * @returns {string} Template contents with every marker substituted.
 * @throws {Error} When the template contains a marker with no configured local value, so
 * a future Terraform output added to `wrangler.jsonc.tpl` cannot silently leak an
 * unsubstituted `{{name}}` marker into the generated local `wrangler.jsonc`.
 */
function substitute(template) {
  return template.replace(/\{\{(\w+)\}\}/g, (marker, name) => {
    if (!Object.hasOwn(LOCAL_PLACEHOLDER_VALUES, name)) {
      throw new Error(
        `No local value configured for wrangler.jsonc.tpl placeholder "${marker}". ` +
          "Add one to LOCAL_PLACEHOLDER_VALUES in scripts/generate-local-wrangler.js.",
      );
    }
    return LOCAL_PLACEHOLDER_VALUES[name];
  });
}

function main() {
  if (existsSync(outputPath)) {
    console.log(
      `wrangler.jsonc already exists at ${outputPath}; leaving it as-is.`,
    );
    return;
  }

  if (!existsSync(templatePath)) {
    console.error(
      `Cannot generate a local wrangler.jsonc: template not found at ${templatePath}`,
    );
    process.exitCode = 1;
    return;
  }

  const template = readFileSync(templatePath, "utf8");
  const content = substitute(template);
  writeFileSync(outputPath, content);
  console.log(
    `Generated local wrangler.jsonc at ${outputPath} from wrangler.jsonc.tpl.`,
  );
}

main();
