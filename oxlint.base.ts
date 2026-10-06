import { defineConfig } from 'oxlint';

/**
 * Shared baseline for every demo. Framework and TypeScript-project concerns belong in the nearest
 * demo-level `oxlint.config.ts`, because Oxlint does not merge nested configs by default.
 */
export default defineConfig({
  // Prevent this shared file from implicitly adding Oxlint's default plugin set. Each demo
  // explicitly opts into the framework/type plugins it needs.
  plugins: [],
  categories: {
    correctness: 'error',
    suspicious: 'error'
  },
  rules: {
    'typescript/no-floating-promises': 'error',
    'typescript/no-misused-promises': 'error',
    'typescript/no-misused-spread': 'off',
    'typescript/no-unsafe-type-assertion': 'off',
    'typescript/no-unnecessary-type-assertion': 'off',
    'typescript/unbound-method': 'off'
  }
});
