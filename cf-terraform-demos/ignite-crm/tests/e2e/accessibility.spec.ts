/**
 * @file WCAG 2.2 AA checks in a real browser (Phase 7, deliverable 4). axe-core scans every main
 *   page in the light and dark themes (the app follows `prefers-color-scheme`), at the project's
 *   viewport. Then come keyboard checks automation can make: focus returns to a dialog's opener,
 *   target sizes, reflow at 320 CSS px (equivalent to 400% zoom), and reduced motion. Everything
 *   runs against seeded local data through the real local Access login.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { signIn } from './support.ts';

/**
 * Pages to scan: every top-level route plus a seeded record of each kind.
 */
const PAGES = [
  '/',
  '/actions',
  '/deals',
  '/projects',
  '/my-work',
  '/notes',
  '/notes/00000000-0000-4000-8000-000000000201',
  '/contacts',
  '/contacts/00000000-0000-4000-8000-0000000000b1',
  '/companies',
  '/reports',
  '/team',
  '/audit',
  '/account',
  '/no-such-page'
] as const;

/**
 * Run axe with the WCAG 2.0–2.2 A/AA rule tags and return a readable summary of violations.
 *
 * @param page The page.
 * @returns One line per violating node.
 */
async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return result.violations.flatMap((violation) =>
    violation.nodes.map(
      (node) =>
        `${violation.id} (${violation.impact}): ${node.target.join(' ')} — ${node.failureSummary?.split('\n')[1]?.trim() ?? ''}`
    )
  );
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test(`every page passes axe WCAG 2.2 AA in the ${scheme} theme`, async ({ page }) => {
      await signIn(page, 'owner@example.com');
      const found: string[] = [];
      for (const path of PAGES) {
        await page.goto(path);
        await expect(page.locator('#main h1').first()).toBeVisible();
        // Let lazily loaded parts (Markdown, overview) settle before scanning.
        await page.waitForLoadState('networkidle');
        found.push(...(await violations(page)).map((line) => `${path}: ${line}`));
      }
      expect(found).toEqual([]);
    });
  });
}

test('dialogs return focus to the control that opened them', async ({ page }) => {
  await signIn(page, 'owner@example.com', '/contacts');
  const opener = page.getByRole('button', { name: 'New contact' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Vuetify moves focus into the dialog (its content container) once it opens.
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(opener).toBeFocused();
});

test('controls meet the 24 × 24 px minimum target size', async ({ page }) => {
  await signIn(page, 'owner@example.com', '/deals/00000000-0000-4000-8000-0000000000d1');
  await page.waitForLoadState('networkidle');
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#main button, #main a, #main [role="button"]')]
      .filter((element) => element.offsetParent !== null)
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && (box.width < 24 || box.height < 24))
      // Inline text links are exempt (2.5.8 “inline” exception).
      .filter(
        ({ element }) =>
          !(
            element.tagName === 'A'
            && element.closest('p, li, td, .text-body-2, .v-list-item-subtitle, .v-breadcrumbs')
          )
      )
      .map(
        ({ element, box }) =>
          `${element.tagName} "${element.textContent?.trim() || element.getAttribute('aria-label')}" ${Math.round(box.width)}×${Math.round(box.height)}`
      )
  );
  expect(small).toEqual([]);
});

test('reflows without horizontal scrolling at 320 CSS px (400% zoom)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await signIn(page, 'owner@example.com');
  for (const path of [
    '/',
    '/contacts/00000000-0000-4000-8000-0000000000b1',
    '/reports',
    '/notes'
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('respects prefers-reduced-motion for transitions', async ({ page }) => {
    await signIn(page, 'owner@example.com', '/contacts');
    await page.getByRole('button', { name: 'New contact' }).click();
    const duration = await page
      .getByRole('dialog')
      .evaluate(
        (element) =>
          getComputedStyle(element.querySelector('.v-overlay__content')!).transitionDuration
      );
    expect(duration.split(',').every((part) => Number.parseFloat(part) <= 0.01)).toBe(true);
  });
});
