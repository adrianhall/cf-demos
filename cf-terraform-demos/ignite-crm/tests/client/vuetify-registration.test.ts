/**
 * @file The Vuetify registration in `src/client/vuetify.ts` lists exactly the components the SPA's
 *   templates use (specification §10.1): no unused component is shipped in the asset bundle, and no
 *   used component is missing (which would render as an unknown element). Reads source files, so it
 *   fails the moment a template and the registration drift apart.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { components } from '../../src/client/vuetify.ts';

const CLIENT = path.resolve(import.meta.dirname, '../../src/client');

/**
 * Every `.vue` file under the client source.
 *
 * @param directory Directory to scan.
 * @returns Absolute paths.
 */
function vueFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return vueFiles(full);
    }
    return entry.name.endsWith('.vue') ? [full] : [];
  });
}

describe('Vuetify registration', () => {
  it('registers exactly the Vuetify components the templates use', () => {
    const registered = new Set(Object.keys(components));
    const used = new Set<string>();
    for (const file of vueFiles(CLIENT)) {
      const template = readFileSync(file, 'utf8');
      for (const [, tag] of template.matchAll(/<(v-[a-z-]+)/gu)) {
        used.add(
          tag!
            .split('-')
            .map((part) => part[0]!.toUpperCase() + part.slice(1))
            .join('')
        );
      }
    }
    expect(registered.size).toBeGreaterThan(10);
    expect([...used].filter((name) => !registered.has(name)).sort()).toEqual([]);
    expect([...registered].filter((name) => !used.has(name)).sort()).toEqual([]);
  });
});
