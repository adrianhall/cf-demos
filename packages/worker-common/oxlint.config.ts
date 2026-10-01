import { defineConfig } from 'oxlint';
import baseConfig from '../../oxlint.base.ts';

/**
 * Lint configuration for the shared Worker library.
 *
 * `typeAware` and `typeCheck` stay here rather than in the shared baseline: those options are
 * root-config-only, and this package owns its own TypeScript project.
 */
export default defineConfig({
  extends: [baseConfig],
  plugins: ['typescript'],
  options: {
    typeAware: true,
    typeCheck: true
  },
  ignorePatterns: ['coverage/', 'node_modules/']
});
