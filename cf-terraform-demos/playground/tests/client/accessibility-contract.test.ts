/**
 * @file The cross-panel accessibility contract, phase 18's deliverable 1. Each panel's own suite
 *   already asserts the things only that panel knows about — a confidence bar's text alternative,
 *   an overlay that must not be the sole carrier of a result. What no per-panel test can catch is a
 *   _structural_ regression that looks correct in isolation: a second `h1`, a heading level skipped
 *   from `h2` to `h4`, a panel that reports a failure with no live region to announce it. Those
 *   only show up when every panel is examined together, and they are the kind of fault a reviewer
 *   reads past. Driven from the view directory rather than a list, so a panel added later is
 *   covered the moment its file exists. These are source assertions rather than rendered-DOM ones.
 *   Mounting all sixteen panels would need a valid fixture per panel and would still only cover the
 *   branches those fixtures reached — a heading inside a result block that only renders after a run
 *   would be invisible to it. Reading the template catches the markup wherever it sits.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Demo root, resolved from this test file.
 */
const demoRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Reads every panel view with its filename.
 *
 * @returns Each view's base name and source.
 */
async function views(): Promise<{ name: string; source: string }[]> {
  const directory = path.join(demoRoot, 'src/client/views');
  const entries = await readdir(directory);

  return Promise.all(
    entries
      .filter((entry) => entry.endsWith('.vue'))
      .map(async (entry) => ({
        name: entry,
        source: await readFile(path.join(directory, entry), 'utf8')
      }))
  );
}

/**
 * Extracts the template half of a single-file component.
 *
 * The `<script>` block mentions headings in JSDoc and the `<style>` block selects them, so a naive
 * search over the whole file reports headings that are not markup.
 *
 * @param source The component source.
 * @returns The template, or an empty string when there is none.
 */
function template(source: string): string {
  return /<template>(?<body>[\s\S]*)<\/template>/u.exec(source)?.groups?.['body'] ?? '';
}

describe('heading structure across every panel', () => {
  it('finds the panels to check', async () => {
    expect((await views()).length).toBeGreaterThan(10);
  });

  // The page's one `h1` is rendered by `PanelPage` from the reviewed task name. A view adding its
  // own would give the page two top-level headings, which leaves a screen-reader user unable to
  // tell which names the page.
  it('leaves the single h1 to the shared panel page', async () => {
    for (const { name, source } of await views()) {
      // Activity is not a panel: it has no `PanelPage` wrapper, so it owns its own `h1`.
      if (name === 'ActivityView.vue') {
        continue;
      }

      expect(template(source), `${name} must not declare its own h1`).not.toMatch(/<h1[\s>]/u);
    }
  });

  it('skips no heading level within a panel', async () => {
    for (const { name, source } of await views()) {
      const levels = [...template(source).matchAll(/<h(?<level>[1-6])[\s>]/gu)].map((match) =>
        Number(match.groups?.['level'])
      );

      if (levels.length === 0) {
        continue;
      }

      // Checked against the deepest level seen so far rather than the previous heading, because
      // returning to `h2` after an `h3` is correct — a new section — while jumping to `h4` from
      // `h2` is a skip wherever it happens.
      let deepest = 1;
      for (const level of levels) {
        expect(
          level,
          `${name} skips a heading level, reaching h${level} after h${deepest}`
        ).toBeLessThanOrEqual(deepest + 1);
        deepest = Math.max(deepest, level);
      }
    }
  });
});

describe('status and failure announcements', () => {
  // A panel that renders a failure into ordinary markup shows it to a sighted visitor and tells a
  // screen-reader user nothing: without a live region, the change is silent and the visitor is
  // left waiting for a result that is never coming.
  it('announces every rendered error through a live region', async () => {
    for (const { name, source } of await views()) {
      const body = template(source);

      // Only panels that actually render an error binding need one, which is what keeps this
      // from forcing an empty `role="alert"` into a panel that cannot fail.
      if (!/\berror\b/u.test(body)) {
        continue;
      }

      expect(body, `${name} renders an error with no role="alert"`).toMatch(/role="alert"/u);
    }
  });
});

describe('motion preferences', () => {
  // A visitor who has asked their system for reduced motion has asked for it everywhere. Any
  // component introducing its own animation has to honour that itself — the shell's media query
  // does not reach into it.
  it('pairs every animation with a reduced-motion rule', async () => {
    const roots = ['src/client/views', 'src/client/components', 'src/client/features'];
    const offenders: string[] = [];

    for (const root of roots) {
      const stack = [path.join(demoRoot, root)];

      while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined) {
          break;
        }

        for (const dirent of await readdir(current, { withFileTypes: true })) {
          const absolute = path.join(current, dirent.name);

          if (dirent.isDirectory()) {
            stack.push(absolute);
            continue;
          }
          if (!dirent.name.endsWith('.vue')) {
            continue;
          }

          const source = await readFile(absolute, 'utf8');
          // `animation:` rather than `transition:`. A transition on a colour or an outline is not
          // motion and reducing it would make focus harder to follow, which is the opposite of
          // the intent; a keyframe animation is the thing a visitor asked to be spared.
          const animates = /\banimation(?:-name)?:\s*(?!none)/u.test(source);
          const respects = source.includes('prefers-reduced-motion');

          if (animates && !respects) {
            offenders.push(path.relative(demoRoot, absolute));
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
