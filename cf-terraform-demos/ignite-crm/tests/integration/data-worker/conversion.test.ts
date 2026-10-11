/**
 * @file Won-deal conversion against real D1: the production composition over the real `D1Adapter`,
 *   with an injected failure at the end of the conversion write set. Proves that a failure after
 *   the transaction starts rolls back the project, conversion record, deal back-link, audit, and
 *   idempotency rows on D1 itself — not only on the SQLite fake used by the unit suite.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { composeWithPort } from '../../../src/data-worker/composition.ts';
import {
  D1Adapter,
  type D1Port,
  type D1TransactionPort,
  sql
} from '../../../src/data-worker/infrastructure/d1/d1-port.ts';
import type { ActorContext } from '../../../src/shared/data-service/contract.ts';
import { migrate, seedUser } from '../support.ts';

/**
 * A real D1 port whose next write set gets one extra statement that always fails — a deterministic
 * stand-in for D1 failing part-way through the batch.
 */
class FailingTailPort implements D1Port {
  /**
   * Whether the next write set should fail.
   */
  failNext = false;

  /**
   * @param inner The real adapter.
   */
  constructor(private readonly inner: D1Adapter) {}

  /**
   * @inheritdoc
   */
  read<T>(statement: Parameters<D1Port['read']>[0]): Promise<readonly T[]> {
    return this.inner.read<T>(statement);
  }

  /**
   * @inheritdoc
   */
  readOne<T>(statement: Parameters<D1Port['readOne']>[0]): Promise<T | null> {
    return this.inner.readOne<T>(statement);
  }

  /**
   * @inheritdoc
   */
  transaction<T>(work: (tx: D1TransactionPort) => Promise<T>): Promise<T> {
    const fail = this.failNext;
    this.failNext = false;
    return this.inner.transaction(async (tx) => {
      const result = await work(tx);
      if (fail) {
        tx.write(sql('INSERT INTO no_such_table (x) VALUES (1)'));
      }
      return result;
    });
  }
}

/**
 * Count one table's rows matching a predicate.
 *
 * @param table Table (test constant).
 * @param where Predicate (test constant).
 * @returns The count.
 */
async function count(table: string, where = '1 = 1'): Promise<number> {
  return (
    (
      await env.DATA_DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).first<{
        n: number;
      }>()
    )?.n ?? 0
  );
}

let sales: ActorContext;

beforeAll(async () => {
  await migrate();
  const userId = await seedUser('convert-sales@example.com', 'sales');
  sales = { email: 'convert-sales@example.com', userId, requestId: 'conv', channel: 'api' };
});

describe('convertDeal over real D1', () => {
  it('rolls back both the win and project when the combined write fails, then succeeds once', async () => {
    const port = new FailingTailPort(new D1Adapter(env.DATA_DB));
    const service = composeWithPort(port, 'owner@example.com', {
      now: () => new Date(),
      newId: () => crypto.randomUUID()
    });
    const contact = await service.crm.createContact(
      sales,
      {
        firstName: 'Combined',
        lastName: null,
        email: null,
        phone: null,
        jobTitle: null,
        companyId: null,
        companyName: 'Combined Ltd'
      },
      { idempotencyKey: 'combined-contact' }
    );
    const deal = await service.crm.createDeal(
      sales,
      {
        title: 'Combined close and conversion',
        primaryContactId: contact.id,
        amountMinor: 0,
        statusLine: null,
        nextActionText: null,
        nextActionDate: null,
        expectedCloseDate: null
      },
      { idempotencyKey: 'combined-deal' }
    );
    const before = {
      projects: await count('projects'),
      conversions: await count('conversion_attempts'),
      audit: await count('audit_events')
    };

    port.failNext = true;
    const failure = await service.projects
      .convertDeal(sales, deal.id, { markWon: true }, deal.version, {
        idempotencyKey: 'combined-failure'
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'DEPENDENCY_FAILURE', retryable: true });
    expect({
      projects: await count('projects'),
      conversions: await count('conversion_attempts'),
      audit: await count('audit_events')
    }).toEqual(before);
    expect(await count('idempotency_records', "idempotency_key = 'combined-failure'")).toBe(0);
    const pending = await service.crm.getDeal(sales, deal.id);
    expect(pending.deal).toMatchObject({
      status: 'pending',
      closedAt: null,
      project: null,
      version: deal.version
    });

    const project = await service.projects.convertDeal(
      sales,
      deal.id,
      { markWon: true },
      deal.version,
      { idempotencyKey: 'combined-success' }
    );
    const won = await service.crm.getDeal(sales, deal.id);
    expect(won.deal).toMatchObject({ status: 'won', project: { id: project.id } });
    expect(won.deal.closedAt).not.toBeNull();
    expect(await count('conversion_attempts', `project_id = '${project.id}'`)).toBe(1);
  });

  it('leaves no half-created project when the write set fails, then converts once', async () => {
    const port = new FailingTailPort(new D1Adapter(env.DATA_DB));
    const service = composeWithPort(port, 'owner@example.com', {
      now: () => new Date(),
      newId: () => crypto.randomUUID()
    });
    const contact = await service.crm.createContact(
      sales,
      {
        firstName: 'Rollback',
        lastName: null,
        email: null,
        phone: null,
        jobTitle: null,
        companyId: null,
        companyName: 'Rollback Ltd'
      },
      { idempotencyKey: 'conv-contact' }
    );
    const deal = await service.crm.createDeal(
      sales,
      {
        title: 'Rollback deal',
        primaryContactId: contact.id,
        amountMinor: 0,
        statusLine: null,
        nextActionText: null,
        nextActionDate: null,
        expectedCloseDate: null
      },
      { idempotencyKey: 'conv-deal' }
    );
    const won = await service.crm.updateDeal(sales, deal.id, { status: 'won' }, 1, {
      idempotencyKey: 'conv-won'
    });
    const before = {
      projects: await count('projects'),
      conversions: await count('conversion_attempts'),
      audit: await count('audit_events')
    };

    port.failNext = true;
    const failure = await service.projects
      .convertDeal(sales, deal.id, {}, won.version, { idempotencyKey: 'conv-fail' })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'DEPENDENCY_FAILURE', retryable: true });
    expect({
      projects: await count('projects'),
      conversions: await count('conversion_attempts'),
      audit: await count('audit_events')
    }).toEqual(before);
    expect(
      await count('deals', `id = '${deal.id}' AND project_id IS NULL AND version = ${won.version}`)
    ).toBe(1);
    expect(await count('idempotency_records', "idempotency_key = 'conv-fail'")).toBe(0);

    const project = await service.projects.convertDeal(sales, deal.id, {}, won.version, {
      idempotencyKey: 'conv-success'
    });
    expect(await count('deals', `id = '${deal.id}' AND project_id = '${project.id}'`)).toBe(1);
    expect(await count('conversion_attempts', `project_id = '${project.id}'`)).toBe(1);
  });
});
