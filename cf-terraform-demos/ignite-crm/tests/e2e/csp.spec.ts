/**
 * @file The SPA works under the Content-Security-Policy in `public/_headers`. `cf dev` does not
 *   apply `_headers` to static assets (the deployed asset service does), so this journey adds the
 *   exact policy to every HTML response through Playwright routing, then fails on any CSP violation
 *   the browser reports while the main pages render. That proves the policy is compatible with
 *   Vuetify's runtime theme styles and the lazily loaded chunks before deploying.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { signIn } from './support.ts';

/**
 * The policy as committed.
 */
const POLICY = /Content-Security-Policy: (.+)/u.exec(
  readFileSync(path.resolve(import.meta.dirname, '../../public/_headers'), 'utf8')
)![1]!;

test('the SPA renders every main page under the committed CSP with no violations', async ({
  page
}) => {
  await signIn(page, 'owner@example.com');
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.resourceType() !== 'document') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'content-security-policy': POLICY }
    });
  });
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/iu.test(message.text())) {
      violations.push(message.text());
    }
  });
  for (const target of ['/', '/deals', '/notes/00000000-0000-4000-8000-000000000201', '/reports']) {
    await page.goto(target);
    await expect(page.locator('#main h1').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
  }
  // A note body renders through the lazily loaded Markdown chunk.
  await page.goto('/notes/00000000-0000-4000-8000-000000000201');
  await expect(page.getByTestId('markdown-view')).toBeVisible();
  expect(violations).toEqual([]);
});
