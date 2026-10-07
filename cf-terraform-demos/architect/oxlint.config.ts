import { defineConfig } from 'oxlint';
import baseConfig from '../../oxlint.base.ts';

/**
 * Cloudflare Workers and React configuration for this demo.
 *
 * `typeAware` and `typeCheck` intentionally stay here rather than in the shared baseline: those
 * options are root-config-only, and every demo owns its own TypeScript project.
 *
 * This is the family's only React demo — every sibling is Vue — because `@xyflow/react` is
 * React-only and is the diagram engine the entire editor is built on. The React plugin is therefore
 * declared here rather than in the shared baseline, which deliberately enables no plugins at all so
 * a framework choice cannot leak between demos.
 *
 * `jsx-a11y` is enabled deliberately rather than inherited. This demo ports a set of specific,
 * hard-won accessibility fixes — modal focus management, minimum target sizes, keyboard paths that
 * do not depend on drag-and-drop — and a lint rule that catches a missing label or a click handler
 * on a non-interactive element is the cheapest place to keep them.
 */
export default defineConfig({
  extends: [baseConfig],
  plugins: ['typescript', 'react', 'jsx-a11y'],
  options: {
    typeAware: true,
    typeCheck: true
  },
  rules: {
    // The automatic JSX runtime (`"jsx": "react-jsx"` in tsconfig.json, and
    // `@vitejs/plugin-react`) injects the factory itself, so a component importing `React` purely
    // to satisfy this rule would be importing a binding it never references. The rule predates
    // that runtime.
    'react/react-in-jsx-scope': 'off'
  },
  ignorePatterns: [
    '.cloudflare/',
    'coverage/',
    'dist/',
    'infra/outputs.json',
    'node_modules/',
    // The Workers-runtime suite imports `cloudflare:test`/`cloudflare:workers`, which only resolve
    // inside the Workers pool. Type-aware linting runs in Node and cannot resolve them.
    'tests/integration/'
  ]
});
