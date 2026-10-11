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
  }
}
