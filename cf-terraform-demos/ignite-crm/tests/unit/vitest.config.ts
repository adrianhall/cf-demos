import { defineProject } from 'vitest/config';
import { workersAliases } from '../workers-aliases.ts';

/**
 * Pure unit tests: shared schemas, domain rules, application services over in-memory ports, and the
 * Application Worker's Hono app over the fake Data Worker. Runs in Node with no Workers runtime, so
 * the modules that only exist inside workerd are aliased (see `../workers-aliases.ts`).
 */
export default defineProject({
  resolve: { alias: [...workersAliases] },
  test: {
    name: 'unit',
    environment: 'node',
    include: ['**/*.test.ts']
  }
});
