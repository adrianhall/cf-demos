import { defineProject } from 'vitest/config';

/**
 * Browser-like test project for the React administrative interface.
 */
export default defineProject({
  test: {
    environment: 'jsdom',
    include: ['**/*.test.tsx'],
    name: 'client',
    setupFiles: ['./setup.ts']
  }
});
