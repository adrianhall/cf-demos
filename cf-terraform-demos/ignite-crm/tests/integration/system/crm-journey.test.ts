/**
 * @file System tests: both Workers, real RPC, real D1, real migrations.
 */

import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, migrate, seedUser } from '../support.ts';

beforeAll(async () => {
  await migrate();
  await seedUser('sales@example.com', 'sales');
  await seedUser('readonly@example.com', 'read-only');
  await seedUser('delivery@example.com', 'delivery');
  await seedUser('suspended@example.com', 'sales', 'suspended');
});

describe('health and configuration', () => {
  it('reports the latest migration through the Data Worker', async () => {
    const response = await api('/api/v1/health', { as: 'sales@example.com' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      data: { status: 'ok', migration: '0008_agent_channel.sql' }
    });
    expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('serves the UK display configuration', async () => {
    const response = await api('/api/v1/configuration', { as: 'sales@example.com' });
    expect(await response.json()).toMatchObject({ currencyCode: 'GBP', locale: 'en-GB' });
  });
});

describe('identity and session', () => {
  it('makes ADMIN_EMAIL the owner on first sign-in', async () => {
    const response = await api('/api/v1/session', { as: 'Owner@Example.com' });
    expect(response.status).toBe(200);
    const session = (await response.json()) as {
      user: { email: string };
      roles: { id: string }[];
      permissions: string[];
    };
    expect(session.user.email).toBe('owner@example.com');
    expect(session.roles.map((role) => role.id)).toEqual(['owner']);
    expect(session.permissions).toContain('users.manage');
  });

  it('auto-provisions an unknown identity as read-only, with an audit event', async () => {
    const response = await api('/api/v1/session', { as: 'newcomer@example.com' });
    const session = (await response.json()) as { roles: { id: string }[]; permissions: string[] };
    expect(session.roles.map((role) => role.id)).toEqual(['read-only']);
    expect(session.permissions).not.toContain('crm.write');
    const audit = await env.DATA_DB.prepare(
      "SELECT count(*) AS n FROM audit_events a JOIN users u ON u.id = a.entity_id WHERE u.email = ? AND a.action = 'provisioned'"
    )
      .bind('newcomer@example.com')
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('refuses a suspended account with 403', async () => {
    const response = await api('/api/v1/session', { as: 'suspended@example.com' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns 401 problem details with no token', async () => {
    const response = await api('/api/v1/session');
    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
  });

  it('rejects a token minted for a different Access application', async () => {
    const response = await api('/api/v1/session', {
      as: 'sales@example.com',
      audience: 'b'.repeat(64)
    });
    expect(response.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const response = await api('/api/v1/session', { as: 'sales@example.com', lifetime: -60 });
    expect(response.status).toBe(401);
  });

  it('ignores a smuggled identity header and uses the verified token', async () => {
    const response = await api('/api/me', {
      as: 'readonly@example.com',
      headers: { 'Cf-Access-Authenticated-User-Email': 'owner@example.com' }
    });
    expect(await response.json()).toEqual({ email: 'readonly@example.com' });
  });
});

describe('contact and company journey', () => {
  it('creates a contact and its company, finds it by search, and opens both records', async () => {
    const created = await api('/api/v1/contacts', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'journey-create-1' },
      json: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ADA@Analytical.example',
        companyName: 'Analytical Engines'
      }
    });
    expect(created.status).toBe(201);
    const contact = (await created.json()) as {
      id: string;
      email: string;
      company: { id: string; name: string };
    };
    expect(contact.email).toBe('ada@analytical.example');
    expect(created.headers.get('Location')).toBe(`/api/v1/contacts/${contact.id}`);

    const search = await api('/api/v1/contacts?q=lovel', { as: 'readonly@example.com' });
    const page = (await search.json()) as { items: { id: string }[] };
    expect(page.items.map((item) => item.id)).toContain(contact.id);

    const detail = await api(`/api/v1/contacts/${contact.id}`, { as: 'readonly@example.com' });
    expect(detail.headers.get('ETag')).toBe('"1"');
    const body = (await detail.json()) as { history: { action: string }[] };
    expect(body.history.map((entry) => entry.action)).toEqual(['created']);

    const company = await api(`/api/v1/companies/${contact.company.id}`, {
      as: 'readonly@example.com'
    });
    const companyBody = (await company.json()) as { contacts: { id: string }[] };
    expect(companyBody.contacts.map((item) => item.id)).toEqual([contact.id]);
  });

  it('reuses an existing company case-insensitively', async () => {
    const first = await api('/api/v1/contacts', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'reuse-company-1' },
      json: { firstName: 'Grace', companyName: 'Hopper Systems' }
    });
    const second = await api('/api/v1/contacts', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'reuse-company-2' },
      json: { firstName: 'Margaret', companyName: 'hopper systems' }
    });
    const a = (await first.json()) as { company: { id: string } };
    const b = (await second.json()) as { company: { id: string; name: string } };
    expect(b.company).toEqual({ id: a.company.id, name: 'Hopper Systems' });
  });

  it('replays an idempotent retry and refuses key reuse with a different body', async () => {
    const request = {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'replay-key-1' },
      json: { firstName: 'Replay' }
    };
    const first = (await (await api('/api/v1/contacts', request)).json()) as { id: string };
    const again = await api('/api/v1/contacts', request);
    expect(again.status).toBe(201);
    expect(((await again.json()) as { id: string }).id).toBe(first.id);

    const conflicting = await api('/api/v1/contacts', {
      ...request,
      json: { firstName: 'Different' }
    });
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('denies a read-only user from creating, writing nothing', async () => {
    const before = await env.DATA_DB.prepare('SELECT count(*) AS n FROM contacts').first<{
      n: number;
    }>();
    const response = await api('/api/v1/contacts', {
      as: 'readonly@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'denied-create-1' },
      json: { firstName: 'Nope' }
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN', retryable: false });
    const after = await env.DATA_DB.prepare('SELECT count(*) AS n FROM contacts').first<{
      n: number;
    }>();
    expect(after?.n).toBe(before?.n);
  });

  it('enforces optimistic versions on company updates', async () => {
    const created = await api('/api/v1/companies', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'version-company-1' },
      json: { name: 'Babbage & Co', stockSymbol: 'lse:bab' }
    });
    const company = (await created.json()) as { id: string; stockSymbol: string };
    expect(company.stockSymbol).toBe('LSE:BAB');

    const updated = await api(`/api/v1/companies/${company.id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'version-update-1', 'If-Match': '"1"' },
      json: { address: '1 Difference Lane' }
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('ETag')).toBe('"2"');

    const stale = await api(`/api/v1/companies/${company.id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'version-update-2', 'If-Match': '"1"' },
      json: { address: 'Elsewhere' }
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'VERSION_MISMATCH' });
  });

  it('returns 404 problem details for a missing contact', async () => {
    const response = await api(`/api/v1/contacts/${crypto.randomUUID()}`, {
      as: 'sales@example.com'
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('sales journey', () => {
  it('creates a deal, logs a two-person meeting, and surfaces it everywhere — across real RPC', async () => {
    const person = async (firstName: string, key: string) =>
      (await (
        await api('/api/v1/contacts', {
          as: 'sales@example.com',
          method: 'POST',
          headers: { 'Idempotency-Key': key },
          json: { firstName, companyName: 'Journey Ltd' }
        })
      ).json()) as { id: string; company: { id: string } };
    const first = await person('Journey One', 'journey-sales-c1');
    const second = await person('Journey Two', 'journey-sales-c2');

    const created = await api('/api/v1/deals', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'journey-sales-deal' },
      json: {
        title: 'Journey renewal',
        primaryContactId: first.id,
        amountMinor: 990000,
        nextActionText: 'Send contract',
        nextActionDate: '2099-01-01'
      }
    });
    expect(created.status).toBe(201);
    const deal = (await created.json()) as { id: string };

    const meeting = await api('/api/v1/activities', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'journey-sales-meeting' },
      json: {
        type: 'meeting',
        subject: 'Renewal review',
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
        contactIds: [first.id, second.id],
        companyId: first.company.id,
        dealId: deal.id
      }
    });
    expect(meeting.status).toBe(201);
    const { id: meetingId } = (await meeting.json()) as { id: string };

    for (const path of [
      `/api/v1/contacts/${first.id}`,
      `/api/v1/contacts/${second.id}`,
      `/api/v1/companies/${first.company.id}`,
      `/api/v1/deals/${deal.id}`
    ]) {
      const detail = (await (await api(path, { as: 'readonly@example.com' })).json()) as {
        activities: { id: string }[];
      };
      expect(
        detail.activities.map((item) => item.id),
        path
      ).toContain(meetingId);
    }

    const stream = (await (
      await api('/api/v1/action-stream', { as: 'sales@example.com' })
    ).json()) as { items: { kind: string; text: string }[] };
    expect(stream.items).toContainEqual(
      expect.objectContaining({ kind: 'deal', text: 'Send contract' })
    );

    const report = await api('/api/v1/reports/pipeline', { as: 'readonly@example.com' });
    expect(((await report.json()) as { open: { amountMinor: number } }).open.amountMinor).toBe(
      990000
    );
  });

  it('rejects a meeting with a missing contact and writes nothing', async () => {
    const before = await env.DATA_DB.prepare('SELECT count(*) AS n FROM activities').first<{
      n: number;
    }>();
    const page = (await (
      await api('/api/v1/contacts?q=journey%20one', { as: 'sales@example.com' })
    ).json()) as { items: { id: string }[] };
    const response = await api('/api/v1/activities', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'journey-sales-bad' },
      json: {
        type: 'call',
        subject: 'Ghost call',
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
        contactIds: [page.items[0]?.id, crypto.randomUUID()]
      }
    });
    expect(response.status).toBe(422);
    const after = await env.DATA_DB.prepare('SELECT count(*) AS n FROM activities').first<{
      n: number;
    }>();
    expect(after?.n).toBe(before?.n);
  });
});

describe('delivery journey', () => {
  it('wins a deal, converts it once across real RPC, and runs a task on the board and worklist', async () => {
    const contact = (await (
      await api('/api/v1/contacts', {
        as: 'sales@example.com',
        method: 'POST',
        headers: { 'Idempotency-Key': 'journey-delivery-contact' },
        json: { firstName: 'Delivery', lastName: 'Journey', companyName: 'Delivery Ltd' }
      })
    ).json()) as { id: string; company: { id: string } };
    const deal = (await (
      await api('/api/v1/deals', {
        as: 'sales@example.com',
        method: 'POST',
        headers: { 'Idempotency-Key': 'journey-delivery-deal' },
        json: { title: 'Delivery deal', primaryContactId: contact.id }
      })
    ).json()) as { id: string };
    const won = await api(`/api/v1/deals/${deal.id}`, {
      as: 'sales@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'journey-delivery-won', 'If-Match': '"1"' },
      json: { status: 'won' }
    });
    expect(won.status).toBe(200);

    const converted = await api(`/api/v1/deals/${deal.id}/convert`, {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'journey-delivery-convert', 'If-Match': '"2"' },
      json: { name: 'Delivery project' }
    });
    expect(converted.status).toBe(201);
    const project = (await converted.json()) as { id: string };
    const again = await api(`/api/v1/deals/${deal.id}/convert`, {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'journey-delivery-again', 'If-Match': '"3"' }
    });
    expect(again.status).toBe(409);
    expect(
      await env.DATA_DB.prepare('SELECT count(*) AS n FROM projects WHERE source_deal_id = ?')
        .bind(deal.id)
        .first<{ n: number }>()
    ).toEqual({ n: 1 });

    const delivery = (await (
      await api('/api/v1/session', { as: 'delivery@example.com' })
    ).json()) as { user: { id: string } };
    const task = (await (
      await api(`/api/v1/projects/${project.id}/tasks`, {
        as: 'delivery@example.com',
        method: 'POST',
        headers: { 'Idempotency-Key': 'journey-delivery-task' },
        json: { title: 'Kickoff call', priority: 'urgent', assigneeId: delivery.user.id }
      })
    ).json()) as { id: string };
    const moved = await api(`/api/v1/tasks/${task.id}`, {
      as: 'delivery@example.com',
      method: 'PATCH',
      headers: { 'Idempotency-Key': 'journey-delivery-move', 'If-Match': '"1"' },
      json: { status: 'in_review' }
    });
    expect(moved.status).toBe(200);
    const work = (await (await api('/api/v1/my-work', { as: 'delivery@example.com' })).json()) as {
      items: { id: string; status: string }[];
    };
    expect(work.items).toContainEqual(
      expect.objectContaining({ id: task.id, status: 'in_review' })
    );
    const company = (await (
      await api(`/api/v1/companies/${contact.company.id}`, { as: 'readonly@example.com' })
    ).json()) as {
      deals: { id: string; project: { id: string } | null }[];
      projects: { id: string }[];
    };
    expect(company.projects.map((item) => item.id)).toEqual([project.id]);
    expect(company.deals[0]?.project?.id).toBe(project.id);
  });
});

describe('reports and customer overview over real RPC and D1', () => {
  it('serves a filtered pipeline report, a delivery report, and a composite overview', async () => {
    const created = await api('/api/v1/contacts', {
      as: 'sales@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'journey-overview-contact' },
      json: { firstName: 'Overview', lastName: 'Person', companyName: 'Overview Ltd' }
    });
    const contact = (await created.json()) as { id: string; company: { id: string } };

    const pipeline = await api(
      '/api/v1/reports/pipeline?closedFrom=2026-01-01&closedTo=2026-12-31',
      {
        as: 'readonly@example.com'
      }
    );
    expect(pipeline.status).toBe(200);
    expect(await pipeline.json()).toMatchObject({
      filter: { owner: null, closedFrom: '2026-01-01', closedTo: '2026-12-31' }
    });
    expect(
      (
        await api('/api/v1/reports/pipeline?closedFrom=2026-02-01&closedTo=2026-01-01', {
          as: 'readonly@example.com'
        })
      ).status
    ).toBe(422);

    const delivery = await api('/api/v1/reports/delivery', { as: 'delivery@example.com' });
    expect(delivery.status).toBe(200);
    expect(await delivery.json()).toMatchObject({
      filter: { projectStatus: 'active', lead: null }
    });

    const overview = await api(`/api/v1/contacts/${contact.id}/overview`, {
      as: 'readonly@example.com'
    });
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({
      detail: { contact: { id: contact.id } },
      notes: { items: [] },
      warnings: []
    });
    const company = await api(`/api/v1/companies/${contact.company.id}/overview`, {
      as: 'readonly@example.com'
    });
    expect(company.status).toBe(200);
    expect((await api(`/api/v1/contacts/${contact.id}/overview`, {})).status).toBe(401);
  });
});

describe('team administration journey', () => {
  it('invites a teammate, changes their role, and the server boundary moves on the next request', async () => {
    // The bootstrap owner exists after its first request.
    await api('/api/v1/session', { as: 'owner@example.com' });
    const invited = await api('/api/v1/users', {
      as: 'owner@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'journey-invite-1' },
      json: { email: 'teammate@example.com', displayName: 'Teammate', roles: ['read-only'] }
    });
    expect(invited.status).toBe(201);
    const member = (await invited.json()) as { id: string; version: number };

    // The teammate's first request uses the invited role (no auto-provisioned duplicate).
    const contact = {
      firstName: 'Role',
      lastName: 'Check',
      companyName: 'Boundary Ltd'
    };
    const denied = await api('/api/v1/contacts', {
      as: 'teammate@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'journey-team-c1' },
      json: contact
    });
    expect(denied.status).toBe(403);

    const promoted = await api(`/api/v1/users/${member.id}/roles`, {
      as: 'owner@example.com',
      method: 'PUT',
      headers: { 'Idempotency-Key': 'journey-roles-1', 'If-Match': `"${member.version}"` },
      json: { roles: ['sales'] }
    });
    expect(promoted.status).toBe(200);
    const allowed = await api('/api/v1/contacts', {
      as: 'teammate@example.com',
      method: 'POST',
      headers: { 'Idempotency-Key': 'journey-team-c2' },
      json: contact
    });
    expect(allowed.status).toBe(201);

    // A manager sees the trail; a sales user does not; the wrong Access audience never gets in.
    const trail = await api(`/api/v1/audit?entityType=user&entityId=${member.id}`, {
      as: 'owner@example.com'
    });
    expect(
      ((await trail.json()) as { items: { action: string }[] }).items.map((item) => item.action)
    ).toEqual(['roles-changed', 'invited']);
    expect((await api('/api/v1/audit', { as: 'sales@example.com' })).status).toBe(403);
    expect(
      (await api('/api/v1/audit', { as: 'owner@example.com', audience: 'c'.repeat(64) })).status
    ).toBe(401);
  });

  it('keeps the final owner on real D1', async () => {
    const session = (await (await api('/api/v1/session', { as: 'owner@example.com' })).json()) as {
      user: { id: string };
    };
    const team = (await (
      await api('/api/v1/users?q=owner%40example.com', { as: 'owner@example.com' })
    ).json()) as { items: { id: string; version: number }[] };
    const self = team.items.find((item) => item.id === session.user.id)!;
    const response = await api(`/api/v1/users/${self.id}/roles`, {
      as: 'owner@example.com',
      method: 'PUT',
      headers: { 'Idempotency-Key': 'journey-last-owner', 'If-Match': `"${self.version}"` },
      json: { roles: ['manager'] }
    });
    expect(response.status).toBe(409);
  });
});

describe('Data Worker reachability', () => {
  it('answers HTTP with 404: it is RPC-only', async () => {
    const response = await exports.DataEntrypoint.fetch(
      new Request('https://data.internal/anything')
    );
    expect(response.status).toBe(404);
  });
});

describe('Data Worker outage', () => {
  it('returns a retryable 503 when the database is unavailable, without leaking detail', async () => {
    await env.DATA_DB.prepare('ALTER TABLE users RENAME TO users_offline').run();
    try {
      const response = await api('/api/v1/session', { as: 'sales@example.com' });
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ code: 'DEPENDENCY_FAILURE', retryable: true });
      expect(JSON.stringify(body)).not.toMatch(/users|SQLITE|D1_/u);
    } finally {
      await env.DATA_DB.prepare('ALTER TABLE users_offline RENAME TO users').run();
    }
  });
});
