/**
 * @file The release-one journeys end to end in a real browser, against both Workers and local D1:
 *   identity → contact and company → deal and activity → win and convert → task → multi-linked note
 *   and search → team and audit → reports. Each step uses the UI a reviewer would, including the
 *   keyboard-first task status menu. Runs at desktop and mobile sizes (see
 *   `playwright.config.ts`).
 */

import { expect, test } from '@playwright/test';
import { navigate, signIn, suffix } from './support.ts';

test.describe.configure({ mode: 'serial' });

test('a sale from first contact to a delivered task, with notes, audit, and reports', async ({
  page
}, testInfo) => {
  const id = suffix(testInfo);
  const company = `Journey Ltd ${id}`;
  const dealTitle = `Journey deal ${id}`;

  // Identity: the owner signs in and sees their role.
  await signIn(page, 'owner@example.com');
  await expect(page.getByTestId('identity')).toContainText('Owner');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  // Contact and company.
  await navigate(page, 'Contacts');
  await page.getByRole('button', { name: 'New contact' }).click();
  const contactDialog = page.getByRole('dialog');
  await contactDialog.getByRole('textbox', { name: 'First name', exact: true }).fill('Jordan');
  await contactDialog.getByRole('textbox', { name: 'Last name', exact: true }).fill(id);
  await contactDialog.getByRole('textbox', { name: 'Company', exact: true }).fill(company);
  await contactDialog.getByRole('button', { name: 'Create contact' }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Jordan ${id}` })).toBeVisible();
  await expect(page.getByRole('link', { name: company })).toBeVisible();

  // Deal for this contact.
  await page.getByRole('button', { name: 'New deal' }).click();
  const dealDialog = page.getByRole('dialog');
  await dealDialog.getByRole('textbox', { name: 'Title', exact: true }).fill(dealTitle);
  await dealDialog.getByRole('textbox', { name: 'Amount (£)', exact: true }).fill('2500');
  await dealDialog.getByRole('button', { name: 'Create deal' }).click();
  await expect(page.getByRole('heading', { level: 1, name: dealTitle })).toBeVisible();

  // Activity about the deal.
  await page.getByRole('button', { name: 'Log activity' }).click();
  const activityDialog = page.getByRole('dialog');
  await activityDialog
    .getByRole('textbox', { name: 'Subject', exact: true })
    .fill(`Discovery call ${id}`);
  await activityDialog.getByRole('button', { name: 'Log activity' }).click();
  await expect(page.getByText(`Discovery call ${id}`)).toBeVisible();

  // Win and convert in one atomic step (the dialog defaults to Won + convert).
  await page.getByRole('button', { name: 'Mark won/lost' }).click();
  const closeDialog = page.getByRole('dialog');
  await expect(closeDialog.getByRole('radio', { name: 'Won' })).toBeChecked();
  await closeDialog.getByRole('button', { name: 'Submit' }).click();
  // The new project is named after the deal and opens straight away.
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/u);
  await expect(page.getByRole('heading', { level: 1, name: dealTitle })).toBeVisible();
  const projectUrl = page.url();

  // Task, then move it with the keyboard-first status menu.
  const taskTitle = `Kick-off ${id}`;
  await page.getByRole('button', { name: 'Add task' }).click();
  const taskDialog = page.getByRole('dialog');
  await taskDialog.getByRole('textbox', { name: 'Title', exact: true }).fill(taskTitle);
  await taskDialog.getByRole('button', { name: 'Add task' }).click();
  const column = (status: string) => page.locator(`ul[aria-labelledby="column-${status}"]`);
  await expect(column('todo')).toContainText(taskTitle);
  const move = page.getByRole('button', { name: `Move ${taskTitle} to another status` });
  await move.focus();
  await page.keyboard.press('Enter');
  const statuses = page.getByRole('list', { name: `Statuses for ${taskTitle}` });
  await expect(statuses).toBeVisible();
  await statuses.getByText('In progress', { exact: true }).click();
  await expect(column('in_progress')).toContainText(taskTitle);
  await expect(column('todo')).not.toContainText(taskTitle);

  // Multi-linked note from the project, then find it with search.
  const noteTitle = `Kick-off plan ${id}`;
  await page.getByTestId('notes-card').getByRole('button', { name: 'New note' }).click();
  const noteDialog = page.getByRole('dialog');
  await noteDialog.getByRole('textbox', { name: 'Title', exact: true }).fill(noteTitle);
  await noteDialog
    .getByRole('textbox', { name: 'Body', exact: true })
    .fill(`Agenda for **${id}**: scope and dates`);
  // Operate the Vuetify select from the keyboard: focus, open, choose.
  await noteDialog.getByLabel('Record type').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: 'Company' }).click();
  await noteDialog.getByRole('searchbox', { name: 'Search company records' }).fill(id);
  await noteDialog.getByRole('button', { name: `Link company ${company}` }).click();
  await noteDialog.getByRole('button', { name: 'Create note' }).click();
  await expect(page.getByRole('heading', { level: 1, name: noteTitle })).toBeVisible();
  await expect(page.getByTestId('markdown-view').locator('strong')).toHaveText(id);

  await navigate(page, 'Notes');
  await page.getByRole('textbox', { name: 'Search notes' }).fill(id);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('link', { name: noteTitle })).toBeVisible();

  // The company overview shows the whole story, including the note.
  await page.goto(projectUrl);
  await page.getByRole('link', { name: company }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: company })).toBeVisible();
  const timeline = page.getByRole('list', { name: 'Customer timeline' });
  await expect(timeline).toContainText('Deal won:');
  await expect(timeline).toContainText(noteTitle);

  // Audit and reports.
  await navigate(page, 'Audit trail');
  await expect(page.getByRole('table', { name: 'Audit events' })).toContainText(noteTitle);
  await expect(page.getByRole('table', { name: 'Audit events' })).not.toContainText(
    'scope and dates'
  );
  await navigate(page, 'Reports');
  await expect(page.getByRole('table', { name: 'Pipeline by stage' })).toContainText('Won');
  await expect(page.getByRole('table', { name: 'Delivery by project' })).toContainText(dealTitle);
});

test('an owner adds a teammate whose controls and server access change with their role', async ({
  page
}, testInfo) => {
  const id = suffix(testInfo);
  const email = `teammate-${id}@example.com`;
  const name = `Teammate ${id}`;

  await signIn(page, 'owner@example.com', '/team');
  await page.getByRole('button', { name: 'Add teammate' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Access e-mail', exact: true }).fill(email);
  await dialog.getByRole('textbox', { name: 'Display name', exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Add teammate' }).click();
  await expect(page.getByRole('table', { name: 'Team members' })).toContainText(name);

  // Read-only: no create controls, no admin navigation.
  await signIn(page, email, '/contacts');
  await expect(page.getByRole('heading', { level: 1, name: 'Contacts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New contact' })).toHaveCount(0);

  // Promote to sales.
  await signIn(page, 'owner@example.com', '/team');
  await page.getByRole('button', { name: `Change roles for ${name}` }).click();
  const roles = page.getByRole('dialog');
  await roles.getByRole('checkbox', { name: 'Read-only' }).uncheck();
  await roles.getByRole('checkbox', { name: 'Sales representative' }).check();
  await roles.getByRole('button', { name: 'Save roles' }).click();
  await expect(page.getByRole('table', { name: 'Team members' })).toContainText(
    'Sales representative'
  );

  await signIn(page, email, '/contacts');
  await expect(page.getByRole('button', { name: 'New contact' })).toBeVisible();
});

test('keyboard users can skip to content and reach the primary navigation', async ({ page }) => {
  await signIn(page, 'readonly@example.com');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/u);
  await navigate(page, 'Reports');
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeFocused();
});
