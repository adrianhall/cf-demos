import { defineProject } from 'vitest/config';

/**
 * Contract tests: the shared Data Worker contract suite against the in-memory fake. The same suite
 * runs against the real `DataEntrypoint` in the integration project.
 */
export default defineProject({
  test: {
    name: 'contract',
    environment: 'node',
    include: ['**/*.test.ts']
  }
});
