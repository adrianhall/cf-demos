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
        // Measure the policy-rich pure tiers. HTTP/DO adapters are covered by the Workers-runtime
        // projects, where line instrumentation would reward transport mocks instead of exercising
        // the real runtime.
        'src/worker/domain/answer-decision.ts',
        'src/worker/domain/conversation-validation.ts',
        'src/worker/domain/faq-validation.ts',
        'src/worker/domain/documentation.ts',
        'src/worker/application/conversation-service.ts',
        'src/worker/application/faq-service.ts',
        'src/worker/application/index-job-service.ts',
        'src/worker/application/escalation-service.ts',
        'src/worker/domain/escalation.ts'
      ],
      thresholds: { lines: 80, functions: 80, statements: 80 }
    }
  }
});
