import type { AppBindings } from "../bindings";
import { GitHubProviderClient } from "./github";
import { GitLabProviderClient } from "./gitlab";
import type { GitProviderClient, Provider } from "./types";

/**
 * Build the matching {@link GitProviderClient} for a normalized reference's own provider,
 * reading credentials from the same `ProviderSecrets` `../routes/webhooks.ts` already reads at
 * its two route handlers. Shared here so `ReviewPipelineWorkflow` (which needs to construct a
 * client from `event.payload.ref.provider` alone, with no Hono context) does not duplicate the
 * two constructor calls.
 *
 * @param env This Worker's bindings (`AppBindings["Bindings"]`).
 * @param provider Which provider to build a client for.
 * @returns A ready-to-use client.
 */
export function createProviderClient(
  env: AppBindings["Bindings"],
  provider: Provider,
): GitProviderClient {
  if (provider === "github") {
    return new GitHubProviderClient({
      token: env.GITHUB_TOKEN,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    });
  }
  return new GitLabProviderClient({
    token: env.GITLAB_TOKEN,
    webhookSecret: env.GITLAB_WEBHOOK_SECRET,
    baseUrl: env.GITLAB_BASE_URL,
  });
}
