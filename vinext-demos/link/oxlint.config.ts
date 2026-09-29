import { defineConfig } from 'oxlint';
import baseConfig from '../../oxlint.base.ts';

/**
 * Cloudflare Workers, Vinext, and React configuration for this demo.
 */
export default defineConfig({
  extends: [baseConfig],
  plugins: ['typescript'],
  rules: {
    'unicorn/no-array-sort': 'off'
  },
  options: {
    typeAware: true,
    typeCheck: true
  },
  ignorePatterns: [
    '.vinext/',
    '.wrangler/',
    'coverage/',
    'dist/',
    'infra/outputs.json',
    'node_modules/',
    'tests/integration/',
    'worker-configuration.d.ts',
    'wrangler.jsonc'
  ]
});
