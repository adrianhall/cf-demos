import { defineConfig } from 'oxfmt';

/**
 * Configuration for oxfmt. Note that all settings EXCEPT those configured in `.editorconfig` are
 * set here.
 */
export default defineConfig({
  // Include parentheses around a sole arrow function parameter.
  arrowParens: 'always',

  // Put the > of a multi-line HTML (HTML, JSX, Vue, Angular) element at the end of the
  // last line, instead of being alone on the next line.
  bracketSameLine: false,

  // Print spaces between brackets in object literals.
  bracketSpacing: true,

  // Control whether to format embedded parts (For example, CSS-in-JS, or JS-in-Vue,
  // etc.) in the file.
  embeddedLanguageFormatting: 'auto',

  // When expressions wrap lines, print operators at the start of new lines ("start")
  // or at the end of previous lines ("end").
  experimentalOperatorPosition: 'start',

  // Specify the global whitespace sensitivity for HTML, Vue, Angular, and Handlebars.
  htmlWhitespaceSensitivity: 'css',

  // Ignore files matching these glob patterns. Patterns use gitignore-style matching,
  // rooted at the directory containing the configuration file. Files outside that directory
  // cannot be matched; patterns containing .. are rejected as a configuration error.
  // Architect's stylesheet is a source-faithful port. Keep its source formatting byte-for-byte so
  // visual/source parity reviews are meaningful; its built-artifact test verifies the production
  // values that could still regress. This is a deliberate root-level exception rather than a
  // demo-local config, because a local config would replace the shared policy for every file.
  ignorePatterns: ['cf-terraform-demos/architect/src/client/app.css'],

  // Enable JSDoc comment formatting.
  jsdoc: {
    addDefaultToDescription: true,
    bracketSpacing: false,
    capitalizeDescriptions: true,
    commentLineStrategy: 'multiline',
    descriptionTag: false,
    descriptionWithDot: true,
    keepUnparsableExampleIndent: false,
    lineWrappingStyle: 'greedy',
    preferCodeFences: true,
    separateReturnsFromParam: false,
    separateTagGroups: false
  },

  // Use single quotes instead of double quotes in JSX.
  jsxSingleQuote: false,

  // How to wrap object literals when they could fit on one line or span multiple lines.
  objectWrap: 'preserve',

  // By default, formatter will not change wrapping in markdown text since some services
  // use a linebreak-sensitive renderer, e.g. GitHub comments and BitBucket. To wrap prose
  // to the print width, change this option to "always". If you want to force all prose blocks
  // to be on a single line and rely on editor/viewer soft wrapping instead, you can use "never".
  proseWrap: 'always',

  // Change when properties in objects are quoted.
  quoteProps: 'consistent',

  // Print semicolons at the ends of statements.
  semi: true,

  // Enforce single attribute per line in HTML, Vue, and JSX.
  singleAttributePerLine: false,

  // Use single quotes instead of double quotes.
  singleQuote: true,

  // Sort import statements using the similar algorithm as eslint-plugin-perfectionist/sort-imports.
  sortImports: {
    groups: [
      'builtin',
      'external',
      ['internal', 'subpath'],
      ['parent', 'sibling', 'index'],
      'style',
      'unknown'
    ],
    ignoreCase: true,
    internalPattern: ['~/', '@', '#'],
    newlinesBetween: false,
    order: 'asc',
    partitionByComment: true,
    partitionByNewline: false,
    sortSideEffects: false
  },

  // Sort package.json keys.
  sortPackageJson: {
    sortScripts: false
  },

  // Print trailing commas wherever possible in multi-line comma-separated syntactic structures.
  trailingComma: 'none',

  // Whether or not to indent the code inside <script> and <style> tags in Vue files.
  vueIndentScriptAndStyle: false
});
