import { defineProject } from 'vitest/config';

/**
 * Pure unit tests: shared schemas, domain rules, application services over in-memory ports, and the
 * Application Worker's Hono app over the fake Data Worker. Runs in Node with no Workers runtime.
 */
export default defineProject({
  test: {
    name: 'unit',
    environment: 'node',
    include: ['**/*.test.ts']
  }
});
