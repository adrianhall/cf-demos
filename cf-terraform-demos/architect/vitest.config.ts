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
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.config.{ts,js}',
        '**/*.d.ts',
        // Starter-project templates for the scaffold export. They are imported only as raw text
        // through Vite's `?raw` suffix and never executed by this demo, so instrumenting them
        // reports 0% for files that have no code path here to cover — which would be a standing
        // drag on the real figure rather than a finding. Their *contents* are asserted by
        // `tests/client/scaffold.test.ts`, which is the coverage that actually matters: it is
        // the generated project a reader takes away.
        'src/client/lib/scaffold-templates/**'
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80
      }
    }
  }
});
