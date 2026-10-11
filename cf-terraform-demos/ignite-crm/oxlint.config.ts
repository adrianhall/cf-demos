import { defineConfig } from 'oxlint';
import baseConfig from '../../oxlint.base.ts';

/**
 * Cloudflare Workers + Vue configuration for Ignite CRM.
 *
 * `typeAware` and `typeCheck` stay here rather than in the shared baseline: they are
 * root-config-only options, and this demo owns its own TypeScript project.
 */
export default defineConfig({
  extends: [baseConfig],
  plugins: ['typescript', 'vue'],
  options: {
    typeAware: true,
    typeCheck: true
  },
  ignorePatterns: [
    '.cloudflare/',
    'data/.cloudflare/',
    'coverage/',
    'dist/',
    'infra/outputs.json',
    'node_modules/',
    // The Workers-runtime suite imports `cloudflare:test`/`cloudflare:workers`, which only resolve
    // inside the Workers pool; type-aware linting runs in Node and cannot resolve them. Their types
    // are still checked by `check:types:tsc:integration`.
    'tests/integration/'
  ]
});
