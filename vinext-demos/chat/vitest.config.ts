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
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'lcov'],
      include: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/*.config.{ts,js}', '**/*.d.ts']
    }
  }
});
