import type { InstrumenterOptions } from "istanbul-lib-instrument";
import { createInstrumenter } from "istanbul-lib-instrument";
import { defineConfig } from "vitest/config";

/**
 * `@vitest/coverage-istanbul`'s own bundled Babel parser plugin list (`@istanbuljs/schema`'s
 * defaults, plus the `importAttributes` plugin the provider itself adds) has no entry for either
 * decorator proposal, so it throws a `SyntaxError` the moment it tries to instrument any file
 * using TC39 standard decorators -- `src/worker/agents/ReviewRunAgent.ts`'s `@callable()` being
 * the first one in this repository (`agents`'s own `Agent` base class expects the *current*,
 * non-legacy decorators proposal; this project's `tsconfig.json` sets no `experimentalDecorators`
 * flag, so there is nothing here using the older, TypeScript-specific legacy proposal instead).
 * `coverage.instrumenter` lets a project override the provider's default `Instrumenter` entirely;
 * this factory reproduces `@vitest/coverage-istanbul`'s own defaults (read directly from
 * `node_modules/@vitest/coverage-istanbul/dist/provider.js`) with `"decorators"` added to
 * `parserPlugins` -- this only widens what Babel is willing to *parse* while re-emitting the
 * coverage-instrumented source; it does not transform decorators away, since the actual
 * executable code always comes from Vite/esbuild's own transform, never from this pass.
 *
 * `@types/istanbul-lib-instrument` (an unmaintained community package typed against the old
 * `babel-generator`/`babel-types`, not the `@babel/*` scope the real bundled implementation
 * uses) has no `GeneratorOptions.importAttributesKeyword`, so this list intentionally omits the
 * provider's own `generatorOpts` override -- this repository has no `import ... with {...}`
 * syntax anywhere for that setting to matter to.
 */
const parserPlugins: InstrumenterOptions["parserPlugins"] = [
  "asyncGenerators",
  "bigInt",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "dynamicImport",
  "importMeta",
  "numericSeparator",
  "objectRestSpread",
  "optionalCatchBinding",
  "topLevelAwait",
  "decorators",
  ["importAttributes", { deprecatedAssertSyntax: true }],
];

export default defineConfig({
  test: {
    // Phase 1 has no test files yet in any project (worker/client tests arrive from Phase 3
    // onward; see docs/07-PR-REVIEW-AGENT.md's Implementation Plan). Vitest otherwise exits
    // non-zero on an empty run, which would make `npm test` fail on a clean Phase-1 checkout.
    passWithNoTests: true,
    projects: [
      "./src/client/vitest.config.ts",
      "./src/worker/vitest.config.ts",
      "./tests/integration/vitest.config.ts",
    ],
    coverage: {
      provider: "istanbul",
      reportsDirectory: "./coverage",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx,vue}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.config.{ts,js}", "**/*.d.ts"],
      instrumenter: (opts) =>
        createInstrumenter({
          produceSourceMap: true,
          autoWrap: false,
          esModules: true,
          compact: false,
          // `@types/istanbul-lib-instrument` (see this file's own doc comment above) has no
          // `ignoreLines` entry either, despite the real v6.0.3 library supporting it -- cast
          // just this one extra field rather than abandoning the rest of this call's real type
          // checking.
          ...({ ignoreLines: true } as Partial<InstrumenterOptions>),
          ...opts,
          parserPlugins,
        }),
    },
  },
});
