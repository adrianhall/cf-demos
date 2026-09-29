import { defineConfig } from 'oxlint';
import baseConfig from '../../oxlint.base.ts';

/**
 * Cloudflare Workers and Vue configuration for this demo.
 *
 * `typeAware` and `typeCheck` intentionally stay here rather than in the shared baseline: those
 * options are root-config-only, and every future framework demo owns its own TypeScript project.
 */
export default defineConfig({
  extends: [baseConfig],
  plugins: ['typescript'],
  // The shared baseline intentionally enables only correctness/suspicious categories. Keep
  // this test fake's mutable `sort()` behavior out of the cross-framework rule surface.
  rules: {
    'unicorn/no-array-sort': 'off'
  },
  options: {
    typeAware: true,
    typeCheck: true
  },
  ignorePatterns: [
    '.cloudflare/',
    '.wrangler/',
    'coverage/',
    'dist/',
    'infra/outputs.json',
    'node_modules/',
    'tests/integration/'
  ]
});
