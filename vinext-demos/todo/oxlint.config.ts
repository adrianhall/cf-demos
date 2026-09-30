import { defineConfig } from 'oxlint';
import baseConfig from '../../oxlint.base.ts';

/**
 * Cloudflare Workers, Vinext, and React configuration for this demo.
 */
export default defineConfig({
  extends: [baseConfig],
  plugins: ['typescript'],
  options: {
    typeAware: true,
    typeCheck: true
  },
  ignorePatterns: [
    '.next/',
    '.vinext/',
    'coverage/',
    'dist/',
    'infra/outputs.json',
    'node_modules/',
    'tests/integration/'
  ]
});
