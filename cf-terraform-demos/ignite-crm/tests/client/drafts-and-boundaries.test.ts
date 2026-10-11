/**
 * @file Phase 7 corner cases for the SPA's pure helpers and shared field rules: change detection in
 *   the deal and task drafts (every field, blank-to-null, company-follows-contact, explicit owner
 *   assignment), record-link search for every type, the Markdown URL allowlist's obfuscation and
 *   parse-failure paths, the optional-date rule, and Unicode length boundaries.
 */

import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../../src/client/services/api-client.ts';
import {
  type DealFormValue,
  toCreateDealInput,
  toUpdateDealInput
} from '../../src/client/services/deal-draft.ts';
import { searchLinkOptions } from '../../src/client/services/link-search.ts';
import {
  isSafeHref,
  renderMarkdown,
  sanitizeNoteHtml
} from '../../src/client/services/markdown-renderer.ts';
import {
  type TaskFormValue,
  toCreateTaskInput,
  toUpdateTaskInput
} from '../../src/client/services/task-draft.ts';
import type { Task } from '../../src/shared/api/projects.ts';
import type { Deal } from '../../src/shared/api/sales.ts';
import { OptionalDateSchema, requiredText } from '../../src/shared/validation/fields.ts';

const USER = { id: '00000000-0000-4000-8000-000000000001', displayName: 'Sam' };
const OTHER = { id: '00000000-0000-4000-8000-000000000002', displayName: 'Mo' };
const STAGE = {
  id: '10000000-0000-4000-8000-000000000011',
  key: 'lead',
  label: 'Lead',
  position: 1
};
const COMPANY = { id: '00000000-0000-4000-8000-0000000000c1', name: 'Engines' };
const CONTACT = { id: '00000000-0000-4000-8000-0000000000a1', displayName: 'Ada' };

/**
 * A stored deal.
 *
 * @returns The deal.
 */
function storedDeal(): Deal {
  return {
    id: '00000000-0000-4000-8000-0000000000d1',
    title: 'Renewal',
    status: 'pending',
    stage: STAGE,
    pipeline: { id: '10000000-0000-4000-8000-000000000001', name: 'Sales pipeline' },
    company: COMPANY,
    primaryContact: CONTACT,
    owner: USER,
    statusLine: null,
    nextActionText: null,
    nextActionDate: null,
    amountMinor: 100,
    currency: 'GBP',
    expectedCloseDate: null,
    closedAt: null,
    project: null,
    version: 1,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z'
  };
}

/**
 * A deal form value matching {@link storedDeal}.
 *
 * @returns The value.
 */
function dealForm(): DealFormValue {
  return {
    title: 'Renewal',
    contact: { ...CONTACT, companyId: COMPANY.id },
    withCompany: true,
    stageId: STAGE.id,
    status: 'pending',
    amountMinor: 100,
    statusLine: '',
    nextActionText: '',
    nextActionDate: '',
    expectedCloseDate: '',
    ownerId: USER.id
  };
}

describe('deal draft', () => {
  it('sends nothing when unchanged and only the changed fields otherwise', () => {
    const deal = storedDeal();
    expect(toUpdateDealInput(deal, dealForm())).toBeNull();
    expect(toUpdateDealInput(deal, { ...dealForm(), title: '  Renewal  ' })).toBeNull();
    expect(toUpdateDealInput(deal, { ...dealForm(), ownerId: OTHER.id })).toEqual({
      ownerId: OTHER.id
    });
    expect(toUpdateDealInput(deal, { ...dealForm(), withCompany: false })).toEqual({
      companyId: null
    });
    // Choosing another contact always resends the company so the server validates the pair.
    expect(
      toUpdateDealInput(deal, {
        ...dealForm(),
        contact: { id: OTHER.id, displayName: 'Mo', companyId: COMPANY.id }
      })
    ).toEqual({ primaryContactId: OTHER.id, companyId: COMPANY.id });
  });

  it('ignores next-action fields once the deal is closed', () => {
    expect(
      toUpdateDealInput(storedDeal(), {
        ...dealForm(),
        status: 'won',
        nextActionText: 'Ignored',
        nextActionDate: '2026-10-20'
      })
    ).toEqual({ status: 'won' });
  });

  it('omits the owner when the caller owns the new deal and maps blanks to null', () => {
    const input = toCreateDealInput(
      { ...dealForm(), withCompany: false, statusLine: '  ' },
      USER.id
    );
    expect(input).toMatchObject({ companyId: null, statusLine: null, nextActionDate: null });
    expect(input).not.toHaveProperty('ownerId');
    expect(toCreateDealInput({ ...dealForm(), ownerId: '' }, USER.id)).not.toHaveProperty(
      'ownerId'
    );
    expect(toCreateDealInput({ ...dealForm(), ownerId: OTHER.id }, USER.id)).toMatchObject({
      ownerId: OTHER.id
    });
  });
});

describe('task draft', () => {
  const task: Task = {
    id: '00000000-0000-4000-8000-0000000000e1',
    project: { id: '00000000-0000-4000-8000-0000000000f1', name: 'Rollout' },
    title: 'Kick-off',
    description: null,
    status: 'todo',
    priority: 'low',
    assignee: null,
    dueDate: null,
    position: 0,
    createdBy: USER,
    completedAt: null,
    version: 1,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z'
  };
  const form: TaskFormValue = {
    title: 'Kick-off',
    description: '   ',
    status: 'todo',
    priority: 'low',
    assigneeId: null,
    dueDate: ''
  };

  it('treats blank text as null and detects a change to every field', () => {
    expect(toCreateTaskInput(form)).toMatchObject({ description: null, dueDate: null });
    expect(toUpdateTaskInput(task, form)).toBeNull();
    expect(
      toUpdateTaskInput(task, {
        title: ' Plan ',
        description: 'Scope',
        status: 'in_progress',
        priority: 'urgent',
        assigneeId: OTHER.id,
        dueDate: '2026-10-20'
      })
    ).toEqual({
      title: 'Plan',
      description: 'Scope',
      status: 'in_progress',
      priority: 'urgent',
      assigneeId: OTHER.id,
      dueDate: '2026-10-20'
    });
    expect(toUpdateTaskInput({ ...task, assignee: OTHER }, { ...form, assigneeId: null })).toEqual({
      assigneeId: null
    });
  });
});

describe('record link search', () => {
  it('searches each record type through its list endpoint and maps labels', async () => {
    const calls: string[] = [];
    const page = (items: unknown[]) => ({ items, nextCursor: null });
    const client = new ApiClient((input) => {
      calls.push(input);
      return Promise.resolve(new Response('{}', { status: 500 }));
    });
    const stub = Object.assign(Object.create(client) as ApiClient, {
      contacts: (query: object) => (
        calls.push(`contacts ${JSON.stringify(query)}`),
        page([CONTACT])
      ),
      companies: (query: object) => (
        calls.push(`companies ${JSON.stringify(query)}`),
        page([COMPANY])
      ),
      deals: (query: object) => (
        calls.push(`deals ${JSON.stringify(query)}`),
        page([{ id: 'd', title: 'Renewal' }])
      ),
      projects: (query: object) => (
        calls.push(`projects ${JSON.stringify(query)}`),
        page([{ id: 'p', name: 'Rollout' }])
      )
    });
    expect(await searchLinkOptions('contact', '', stub)).toEqual([
      { type: 'contact', id: CONTACT.id, label: 'Ada' }
    ]);
    expect((await searchLinkOptions('company', 'eng', stub))[0]?.label).toBe('Engines');
    expect((await searchLinkOptions('deal', 'ren', stub))[0]?.label).toBe('Renewal');
    expect(await searchLinkOptions('project', 'roll', stub)).toEqual([
      { type: 'project', id: 'p', label: 'Rollout' }
    ]);
    expect(calls).toEqual([
      'contacts {}',
      'companies {"q":"eng"}',
      'deals {"q":"ren"}',
      'projects {"q":"roll"}'
    ]);
  });
});

describe('Markdown URL allowlist', () => {
  it('rejects control-character obfuscation and unparsable URLs, rendering them as text', () => {
    expect(isSafeHref('java\tscript:alert(1)')).toBe(false);
    expect(isSafeHref('https://exa\u0000mple.com')).toBe(false);
    expect(isSafeHref('https://[::1')).toBe(false);
    expect(isSafeHref('/notes/1')).toBe(true);
    expect(isSafeHref('mailto:a@example.com')).toBe(true);
    const element = document.createElement('div');
    element.innerHTML = renderMarkdown('[x](<https://[::1>) [y](https://example.com "T")');
    // The parser renders the unparsable link as plain text; only the safe one is an anchor.
    const anchors = element.querySelectorAll('a');
    expect(anchors).toHaveLength(1);
    const safe = anchors[0];
    expect(safe?.getAttribute('title')).toBe('T');
    expect(safe?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });
});

describe('the sanitiser as an independent layer', () => {
  it('strips what a buggy parser might emit', () => {
    const element = document.createElement('div');
    element.innerHTML = sanitizeNoteHtml(
      '<a href="java&#x09;script:alert(1)">a</a><a href="data:text/html,x">b</a>'
        + '<input type="text" value="x"><input type="checkbox" checked>'
        + '<img src="https://tracker.example/p.gif" onerror="alert(1)"><script>alert(1)</script>'
        + '<a href="/notes/1" onclick="alert(1)" style="color:red">c</a>'
    );
    const anchors = [...element.querySelectorAll('a')];
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual([null, null, '/notes/1']);
    expect(anchors[2]?.hasAttribute('onclick')).toBe(false);
    expect(anchors[2]?.hasAttribute('style')).toBe(false);
    expect(anchors[2]?.hasAttribute('target')).toBe(false);
    const inputs = [...element.querySelectorAll('input')];
    expect(inputs.map((input) => input.type)).toEqual(['checkbox']);
    expect(inputs[0]?.disabled).toBe(true);
    expect(element.querySelector('img, script')).toBeNull();
  });
});

describe('field boundaries', () => {
  it('treats blank, omitted, and null dates as none and trims a real date', () => {
    expect(v.parse(OptionalDateSchema, undefined)).toBeNull();
    expect(v.parse(OptionalDateSchema, null)).toBeNull();
    expect(v.parse(OptionalDateSchema, '   ')).toBeNull();
    expect(v.parse(OptionalDateSchema, ' 2026-02-28 ')).toBe('2026-02-28');
    expect(v.is(OptionalDateSchema, '2026-02-30')).toBe(false);
    expect(v.is(OptionalDateSchema, '28/02/2026')).toBe(false);
  });

  it('measures limits in UTF-16 code units, so astral characters cannot exceed the D1 CHECK', () => {
    // D1's `length()` counts characters; valibot counts UTF-16 units, which is never fewer, so the
    // wire rule is at least as strict as the database constraint and never lets a write fail there.
    const title = requiredText('Title', 200);
    expect(v.is(title, 'é'.repeat(200))).toBe(true);
    expect(v.is(title, 'é'.repeat(201))).toBe(false);
    expect(v.is(title, '🚀'.repeat(100))).toBe(true);
    expect(v.is(title, '🚀'.repeat(101))).toBe(false);
    expect(v.parse(title, '  Ünïcödé  ')).toBe('Ünïcödé');
    expect(v.is(title, ' \u3000 ')).toBe(false);
  });
});
