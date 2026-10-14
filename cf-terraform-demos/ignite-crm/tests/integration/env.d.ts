/**
 * @file Types for the Workers-runtime test environment. The suite runs `system-entry.ts` (both
 *   Workers in one module), so `exports` is typed from that module rather than from the Application
 *   Worker's generated types.
 */

declare namespace Cloudflare {
  interface GlobalProps {
    /**
     * The combined test module.
     */
    mainModule: typeof import('./system-entry.ts');
  }

  interface Env {
    /**
     * Data Worker database.
     */
    DATA_DB: D1Database;
    /**
     * Bootstrap owner e-mail.
     */
    ADMIN_EMAIL: string;
    /**
     * Parsed migrations applied by `beforeAll`.
     */
    TEST_MIGRATIONS: { name: string; queries: string[] }[];
    /**
     * Chat session Durable Objects, over the test module's own agent class.
     */
    CHAT_AGENT: DurableObjectNamespace;
    /**
     * Model name, bound as in a deployment. The agent under test uses a scripted model, so the
     * value is never sent anywhere.
     */
    AI_CHAT_MODEL: string;
    /**
     * AI Gateway identifier, bound as in a deployment and likewise never called.
     */
    AI_GATEWAY_ID: string;
  }
}
