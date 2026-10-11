/**
 * @file The D1 port against real D1: atomic write sets, guards, and error translation.
 */

import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  D1Adapter,
  sql,
  translateD1Error
} from '../../../src/data-worker/infrastructure/d1/d1-port.ts';
import { migrate, seedUser } from '../support.ts';

let userId: string;
const db = new D1Adapter(env.DATA_DB);

beforeAll(async () => {
  await migrate();
  userId = await seedUser('port@example.com', 'owner');
});

/**
 * Insert-a-company statement.
 *
 * @param id Company id.
 * @param name Company name.
 * @returns The statement.
 */
function insertCompany(id: string, name: string) {
  const now = new Date().toISOString();
  return sql(
    'INSERT INTO companies (id, name, version, created_by, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)',
    id,
    name,
    userId,
    now,
    now
  );
}

/**
 * Count companies by name.
 *
 * @param name Company name.
 * @returns The count.
 */
async function countNamed(name: string): Promise<number> {
  return (
    (
      await db.readOne<{ n: number }>(
        sql('SELECT count(*) AS n FROM companies WHERE name = ?', name)
      )
    )?.n ?? 0
  );
}

/**
 * Capture a rejection's code.
 *
 * @param promise The operation.
 * @returns The code.
 */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error('expected failure');
}

describe('D1Adapter', () => {
  it('commits a write set and returns the work result', async () => {
    const id = crypto.randomUUID();
    const result = await db.transaction((tx) => {
      tx.write(insertCompany(id, 'Committed'));
      return Promise.resolve('done');
    });
    expect(result).toBe('done');
    expect(await countNamed('Committed')).toBe(1);
    expect(await db.read(sql('SELECT id FROM companies WHERE id = ?', id))).toEqual([{ id }]);
  });

  it('runs no batch for a read-only transaction', async () => {
    expect(
      await db.transaction(
        async (tx) => (await tx.readOne<{ one: number }>(sql('SELECT 1 AS one')))?.one
      )
    ).toBe(1);
  });

  it('rolls back every statement when requireChanged fails', async () => {
    const id = crypto.randomUUID();
    const code = await codeOf(
      db.transaction((tx) => {
        tx.write(insertCompany(id, 'Rolled back by version'));
        tx.write(
          sql('UPDATE companies SET version = version + 1 WHERE id = ? AND version = ?', id, 99)
        );
        tx.requireChanged('VERSION_MISMATCH');
        return Promise.resolve();
      })
    );
    expect(code).toBe('VERSION_MISMATCH');
    expect(await countNamed('Rolled back by version')).toBe(0);
  });

  it('rolls back when requireRow finds nothing, reporting the chosen code', async () => {
    for (const reason of ['NOT_FOUND', 'CONFLICT'] as const) {
      const name = `Rolled back by ${reason}`;
      const code = await codeOf(
        db.transaction((tx) => {
          tx.write(insertCompany(crypto.randomUUID(), name));
          tx.requireRow(
            sql('SELECT count(*) FROM companies WHERE id = ?', crypto.randomUUID()),
            reason
          );
          return Promise.resolve();
        })
      );
      expect(code).toBe(reason);
      expect(await countNamed(name)).toBe(0);
    }
  });

  it('passes guards that hold', async () => {
    const id = crypto.randomUUID();
    await db.transaction((tx) => {
      tx.write(insertCompany(id, 'Guarded'));
      tx.requireChanged('CONFLICT');
      tx.requireRow(sql('SELECT count(*) FROM companies WHERE id = ?', id), 'NOT_FOUND');
      return Promise.resolve();
    });
    expect(await countNamed('Guarded')).toBe(1);
  });

  it('reports a unique-constraint failure as CONFLICT and writes nothing', async () => {
    await db.transaction((tx) => {
      tx.write(insertCompany(crypto.randomUUID(), 'Unique Co'));
      return Promise.resolve();
    });
    const code = await codeOf(
      db.transaction((tx) => {
        tx.write(insertCompany(crypto.randomUUID(), 'Partner of unique'));
        tx.write(insertCompany(crypto.randomUUID(), 'UNIQUE CO'));
        return Promise.resolve();
      })
    );
    expect(code).toBe('CONFLICT');
    expect(await countNamed('Partner of unique')).toBe(0);
  });

  it('reports malformed SQL as a retryable dependency failure without leaking it', async () => {
    const failure = await db
      .read(sql('SELECT * FROM no_such_table'))
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'DEPENDENCY_FAILURE', retryable: true });
    expect((failure as Error).message).not.toContain('no_such_table');
    expect(await codeOf(db.readOne(sql('SELECT nope FROM companies')))).toBe('DEPENDENCY_FAILURE');
  });

  it('translates non-Error values', () => {
    expect(translateD1Error('boom')).toMatchObject({ code: 'DEPENDENCY_FAILURE' });
  });

  it('trusts only known guard reasons and fails closed on anything else', () => {
    expect(translateD1Error(new Error('D1_ERROR: IGNITE_TX_GUARD:NOT_FOUND'))).toMatchObject({
      code: 'NOT_FOUND'
    });
    for (const message of [
      'D1_ERROR: IGNITE_TX_GUARD:FORBIDDEN',
      'D1_ERROR: IGNITE_TX_GUARD:',
      'D1_ERROR: IGNITE_TX_GUARD:internal'
    ]) {
      expect(translateD1Error(new Error(message))).toMatchObject({
        code: 'DEPENDENCY_FAILURE',
        retryable: true
      });
    }
  });
});
