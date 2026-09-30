import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['./tests/worker/vitest.config.ts', './tests/integration/vitest.config.ts'],
    coverage: {
      provider: 'istanbul',
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.config.{ts,js}', '**/*.d.ts']
    }
  }
});
