/**
 * @file The customer overview and report routes through the Hono app with real development-token
 *   Access verification, over the fake Data Worker. The overview's notes read is wrapped so it can
 *   be made to fail on demand, which exercises the three composite outcomes: a retryable notes
 *   failure becomes an explicit partial warning, a notes `FORBIDDEN` fails the whole request
 *   (authorization is never downgraded to partial data), and a core failure is a safe, retryable
 *   503 that leaks no internals. Also the merged timeline, report filters, and their 422/403s.
 */

import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { createAccessMiddleware } from '@demos/worker-common';
import { buildAccessPolicies } from '../../../src/application-worker/api/access-policies.ts';
import { createApiApp } from '../../../src/application-worker/api/app.ts';
import type { ApiEnv } from '../../../src/application-worker/api/context.ts';
import { buildTimeline } from '../../../src/application-worker/overview/customer-overview.ts';
import {
  CompanyOverviewSchema,
  ContactOverviewSchema,
  TIMELINE_LIMIT
} from '../../../src/shared/api/overview.ts';
import { DeliveryReportSchema, PipelineReportSchema } from '../../../src/shared/api/reports.ts';
import { serviceError } from '../../../src/shared/common/errors.ts';
import type { DataService } from '../../../src/shared/data-service/contract.ts';
import { createFakeDataService, testRuntime } from '../../fakes/fake-data-service.ts';

const AUD = 'd'.repeat(64);
const ORIGIN = 'https://crm.example';

/**
 * What the wrapped notes read should do.
 */
type NotesMode = 'ok' | 'unavailable' | 'forbidden' | 'internal';

/**
 * Build the app over a fake with a contact, a won deal converted to a project, an activity, and a
 * note, plus a switch for the notes read.
 *
 * @returns Request helper, ids, and the notes switch.
 */
async function setup() {
  const { service, store } = createFakeDataService({
    runtime: testRuntime(new Date('2026-10-11T09:00:00.000Z'))
  });
  const salesId = store.addUser('sales@example.com', 'sales');
  store.addUser('reader@example.com', 'read-only');
  const sales = {
    email: 'sales@example.com',
    userId: salesId,
    requestId: 'seed',
    channel: 'api'
  } as const;
  const contact = await service.crm.createContact(
    sales,
    {
      firstName: 'Ada',
      lastName: null,
      email: null,
      phone: null,
      jobTitle: null,
      companyId: null,
      companyName: 'Engines'
    },
    { idempotencyKey: 'overview-contact' }
  );
  const deal = await service.crm.createDeal(
    sales,
    {
      title: 'Renewal',
      primaryContactId: contact.id,
      amountMinor: 500,
      statusLine: 'Private remark',
      nextActionText: null,
      nextActionDate: null,
      expectedCloseDate: null
    },
    { idempotencyKey: 'overview-deal' }
  );
  await service.projects.convertDeal(sales, deal.id, { markWon: true }, 1, {
    idempotencyKey: 'overview-convert'
  });
  await service.crm.createActivity(
    sales,
    {
      type: 'call',
      subject: 'Kick-off call',
      summary: 'Secret summary',
      occurredAt: '2026-10-11T08:00:00.000Z',
      durationMinutes: 15,
      contactIds: [contact.id],
      companyId: null,
      dealId: null
    },
    { idempotencyKey: 'overview-activity' }
  );
  await service.notes.createNote(
    sales,
    {
      title: 'Budget call',
      markdown: 'Body text that must never appear in the overview',
      links: [
        { type: 'contact', id: contact.id },
        { type: 'company', id: contact.company!.id }
      ]
    },
    { idempotencyKey: 'overview-note' }
  );

  let notesMode: NotesMode = 'ok';
  let coreDown = false;
  const wrapped: DataService = {
    ...service,
    crm: {
      ...service.crm,
      getContact: (actor, id) =>
        coreDown
          ? Promise.reject(
              serviceError('DEPENDENCY_FAILURE', 'The data service is temporarily unavailable.', {
                requestId: actor.requestId
              })
            )
          : service.crm.getContact(actor, id)
    },
    notes: {
      ...service.notes,
      listNotes: (actor, options) => {
        switch (notesMode) {
          case 'unavailable':
            return Promise.reject(
              serviceError('DEPENDENCY_FAILURE', 'D1_ERROR: SQLITE_BUSY at notes_fts', {
                requestId: actor.requestId
              })
            );
          case 'forbidden':
            return Promise.reject(
              serviceError('FORBIDDEN', 'Not allowed.', { requestId: actor.requestId })
            );
          case 'internal':
            return Promise.reject(new Error('boom: stack trace with secrets'));
          default:
            return service.notes.listNotes(actor, options);
        }
      }
    }
  };
  const app = createApiApp({
    access: createAccessMiddleware<ApiEnv>({
      buildPolicies: buildAccessPolicies,
      enableDevTokens: true
    }),
    dataService: () => wrapped,
    includeStack: false
  });
  const call = async (path: string, as = 'reader@example.com'): Promise<Response> =>
    app.request(
      `${ORIGIN}${path}`,
      { headers: { [JWT_HEADER]: await signDevJwt(as, { audience: AUD }) } },
      { ACCESS_AUD: AUD, ENVIRONMENT: 'test' }
    );
  return {
    call,
    store,
    contactId: contact.id,
    companyId: contact.company!.id,
    setNotes: (mode: NotesMode) => {
      notesMode = mode;
    },
    setCoreDown: (down: boolean) => {
      coreDown = down;
    }
  };
}

describe('customer overview', () => {
  it('returns the core detail, linked notes, and a merged timeline without body text', async () => {
    const { call, contactId, companyId } = await setup();
    const response = await call(`/api/v1/contacts/${contactId}/overview`);
    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe('"1"');
    const overview = v.parse(ContactOverviewSchema, await response.json());
    expect(overview.warnings).toEqual([]);
    expect(overview.notes?.items.map((note) => note.title)).toEqual(['Budget call']);
    expect(overview.timeline.map((entry) => entry.kind).sort()).toEqual([
      'call',
      'deal-opened',
      'deal-won',
      'note',
      'project-started'
    ]);
    const text = JSON.stringify(overview.timeline);
    expect(text).not.toContain('must never appear');
    expect(text).not.toContain('Secret summary');
    expect(text).not.toContain('Private remark');

    const company = v.parse(
      CompanyOverviewSchema,
      await (await call(`/api/v1/companies/${companyId}/overview`)).json()
    );
    expect(company.detail.company.name).toBe('Engines');
    expect(company.notes?.items).toHaveLength(1);
  });

  it('turns a retryable notes failure into an explicit warning and keeps the core', async () => {
    const { call, contactId, setNotes } = await setup();
    setNotes('unavailable');
    const response = await call(`/api/v1/contacts/${contactId}/overview`);
    expect(response.status).toBe(200);
    const overview = v.parse(ContactOverviewSchema, await response.json());
    expect(overview.notes).toBeNull();
    expect(overview.warnings).toEqual([
      {
        section: 'notes',
        message: 'Notes are temporarily unavailable. The rest of this page is up to date.',
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u)
      }
    ]);
    // The D1 detail of the notes failure is not disclosed.
    expect(JSON.stringify(overview)).not.toContain('SQLITE');
    expect(overview.detail.contact.displayName).toBe('Ada');
    expect(overview.timeline.some((entry) => entry.kind === 'note')).toBe(false);
  });

  it('never downgrades a notes authorization failure to partial data', async () => {
    const { call, contactId, setNotes } = await setup();
    setNotes('forbidden');
    const response = await call(`/api/v1/contacts/${contactId}/overview`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('fails the request on an unexpected notes error, without leaking it', async () => {
    const { call, contactId, setNotes } = await setup();
    setNotes('internal');
    const response = await call(`/api/v1/contacts/${contactId}/overview`);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secrets');
  });

  it('maps a core failure to a retryable 503 even when notes succeed', async () => {
    const { call, contactId, setCoreDown } = await setup();
    setCoreDown(true);
    const response = await call(`/api/v1/contacts/${contactId}/overview`);
    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    const problem = (await response.json()) as Record<string, unknown>;
    expect(problem).toMatchObject({ code: 'DEPENDENCY_FAILURE', retryable: true });
    expect(problem).not.toHaveProperty('stack');
  });

  it('reports a missing record as 404 and a malformed id as 422', async () => {
    const { call } = await setup();
    expect(
      (await call('/api/v1/contacts/00000000-0000-4000-8000-00000000ffff/overview')).status
    ).toBe(404);
    expect((await call('/api/v1/companies/nope/overview')).status).toBe(422);
  });
});

describe('buildTimeline', () => {
  it('orders newest first with stable ties and caps the length', () => {
    const user = { id: '00000000-0000-4000-8000-000000000001', displayName: 'U' };
    const notes = Array.from({ length: TIMELINE_LIMIT + 5 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      title: `N${index}`,
      author: user,
      links: [],
      version: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z'
    }));
    const timeline = buildTimeline({ activities: [], deals: [], projects: [], notes });
    expect(timeline).toHaveLength(TIMELINE_LIMIT);
    expect(timeline[0]?.key < timeline[1]!.key).toBe(true);
    expect(buildTimeline({ activities: [], deals: [], projects: [], notes: null })).toEqual([]);
  });
});

describe('report routes', () => {
  it('serves filtered pipeline and delivery reports and validates their query strings', async () => {
    const { call } = await setup();
    const pipeline = await call('/api/v1/reports/pipeline?closedFrom=2026-10-01&ownerId=');
    expect(pipeline.status).toBe(200);
    const report = v.parse(PipelineReportSchema, await pipeline.json());
    expect(report.won).toEqual({ count: 1, amountMinor: 500 });
    expect(report.filter).toEqual({ owner: null, closedFrom: '2026-10-01', closedTo: null });

    const delivery = await call('/api/v1/reports/delivery');
    expect(delivery.status).toBe(200);
    expect(v.parse(DeliveryReportSchema, await delivery.json()).projectCount).toBe(1);

    const reversed = await call(
      '/api/v1/reports/pipeline?closedFrom=2026-10-02&closedTo=2026-10-01'
    );
    expect(reversed.status).toBe(422);
    expect(((await reversed.json()) as { fields: Record<string, string> }).fields).toHaveProperty(
      'closedTo'
    );
    expect((await call('/api/v1/reports/delivery?projectStatus=archived')).status).toBe(422);
    expect((await call('/api/v1/reports/delivery?extra=1')).status).toBe(422);
  });

  it('refuses a caller without report.read', async () => {
    const { call, store } = await setup();
    store.exec("DELETE FROM role_permissions WHERE permission = 'report.read'");
    expect((await call('/api/v1/reports/pipeline')).status).toBe(403);
    expect((await call('/api/v1/reports/delivery')).status).toBe(403);
  });
});
