import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      './tests/client/vitest.config.ts',
      './tests/worker/vitest.config.ts',
      './tests/integration/vitest.config.ts'
    ],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov'],
      // Coverage measures the business-policy boundary and the authenticated shell. D1/AI Search
      // adapters are exercised in the Workers-runtime suite; including environment-bound adapter
      // boilerplate here would make a line target reward mocks rather than policy tests.
      include: [
        'src/worker/application/**/*.ts',
        'src/worker/domain/**/*.ts',
        'src/worker/routes/**/*.ts',
        'src/client/App.vue'
      ],
      thresholds: { lines: 80, functions: 80, statements: 80 }
    }
  }
});
