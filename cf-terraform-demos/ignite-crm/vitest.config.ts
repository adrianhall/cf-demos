import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration: four projects and one Istanbul coverage gate.
 *
 * Coverage measures every authored runtime file under `src`. The only exclusions are tests,
 * declaration files, and configuration; no production module is hidden to reach the threshold.
 * `pnpm test` always runs with `--coverage`, so a green test run proves the 80% gate.
 */
export default defineConfig({
  test: {
    projects: [
      './tests/unit/vitest.config.ts',
      './tests/client/vitest.config.ts',
      './tests/contract/vitest.config.ts',
      './tests/integration/vitest.config.ts'
    ],
    coverage: {
      provider: 'istanbul',
      reportsDirectory: './coverage',
      reporter: ['text-summary', 'text', 'html', 'lcov'],
      include: ['src/**/*.{ts,vue}'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80
      }
    }
  }
});
