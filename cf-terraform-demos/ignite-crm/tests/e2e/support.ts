/**
 * @file Shared Playwright helpers: sign in through the local Cloudflare Access emulation (the same
 *   login form `pnpm start` shows), navigate with the app's own navigation (opening the drawer on
 *   narrow screens), and create unique record names per browser project.
 */

import { expect, type Page, type TestInfo } from '@playwright/test';

/**
 * Sign in as a local development identity, then land on a path.
 *
 * @param page The page.
 * @param email A development identity, e.g. `owner@example.com`.
 * @param path Where to go after signing in.
 * @returns Once the app shell shows the signed-in identity.
 */
export async function signIn(page: Page, email: string, path = '/'): Promise<void> {
  await page.context().clearCookies();
  await page.goto(`/cdn-cgi/access/login?redirect=${encodeURIComponent(path)}`);
  await page.getByLabel('Or enter a custom email address').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('identity')).toBeVisible();
}

/**
 * Open a main navigation entry, opening the drawer first on narrow screens.
 *
 * @param page The page.
 * @param title The navigation entry's title.
 * @returns Once the destination page heading is visible.
 */
export async function navigate(page: Page, title: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const link = nav.getByRole('link', { name: title, exact: true });
  // A closed temporary drawer (narrow screens) is translated off-screen rather than hidden, so
  // test whether the link is inside the viewport, not merely visible.
  const box = await link.boundingBox();
  if (box === null || box.x + box.width <= 0) {
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await expect(nav).toBeInViewport();
  }
  await link.click();
}

/**
 * A suffix that keeps records from the desktop and mobile projects apart.
 *
 * @param info The running test.
 * @returns A short, unique suffix.
 */
export function suffix(info: TestInfo): string {
  return `${info.project.name}-${Date.now().toString(36)}`;
}
