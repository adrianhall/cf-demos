import { defineConfig } from 'oxlint';
import baseConfig from '../../oxlint.base.ts';

/**
 * Cloudflare Workers, Vinext, and React configuration for this demo.
 *
 * `typeAware` and `typeCheck` intentionally stay here rather than in the shared baseline: those
 * options are root-config-only, and every demo owns its own TypeScript project.
 */
export default defineConfig({
  extends: [baseConfig],
  plugins: ['typescript'],
  options: {
    typeAware: true,
    typeCheck: true
  },
  ignorePatterns: [
    '.cloudflare/',
    '.next/',
    '.vinext/',
    'coverage/',
    'dist/',
    'infra/outputs.json',
    'node_modules/',
    // The Workers-runtime suite imports `cloudflare:test`/`cloudflare:workers`, which only resolve
    // inside the Workers pool. Type-aware linting runs in Node and cannot resolve them.
    'tests/integration/'
  ]
});
