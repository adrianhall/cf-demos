import { applyD1Migrations, env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

interface TestEnv extends Env {
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
}
const testEnv = env as TestEnv;
async function request(path: string, token?: string): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://sales.example${path}`, {
      headers: token === undefined ? {} : { [JWT_HEADER]: token }
    })
  );
}
describe('SalesBot Worker', () => {
  beforeAll(async () => applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS));
  it('reports health without authentication', async () =>
    expect((await request('/health')).status).toBe(200));
  it('returns a safe RFC 9457 error for a missing identity', async () => {
    const response = await request('/api/me');
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });
  it('rejects a wrong audience', async () => {
    const response = await request(
      '/api/me',
      await signDevJwt('pm@example.com', { audience: 'b'.repeat(64) })
    );
    expect(response.status).toBe(401);
  });
  it('defaults an unmapped valid identity to salesperson', async () => {
    const response = await request(
      '/api/me',
      await signDevJwt('new@example.com', { audience: 'a'.repeat(64) })
    );
    expect(await response.json()).toEqual({ email: 'new@example.com', role: 'salesperson' });
  });
  it('accepts a valid identity and round-trips the D1 role', async () => {
    await testEnv.DB.prepare(
      "INSERT INTO identities (identity_key, email, role) VALUES ('pm', 'pm@example.com', 'pm')"
    ).run();
    const response = await request(
      '/api/me',
      await signDevJwt('pm@example.com', { audience: 'a'.repeat(64) })
    );
    expect(await response.json()).toEqual({ email: 'pm@example.com', role: 'pm' });
  });
  it('rejects an expired identity', async () => {
    const response = await request(
      '/api/me',
      await signDevJwt('pm@example.com', { audience: 'a'.repeat(64), lifetime: -1 })
    );
    expect(response.status).toBe(401);
  });

  it('seeds the supplied product map', async () => {
    const response = await request(
      '/api/products',
      await signDevJwt('salesperson@example.com', { audience: 'a'.repeat(64) })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { products: { id: string; primaryPm: string }[] };
    expect(body.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'd1', primaryPm: 'Ivory Ibuaka' }),
        expect.objectContaining({ id: 'ai-search', primaryPm: 'Anni Wang' })
      ])
    );
  });

  it('enforces PM scope when publishing, then lets an administrator override', async () => {
    await testEnv.DB.prepare(
      "INSERT OR IGNORE INTO identities (identity_key, email, role) VALUES ('pm-key', 'pm@example.com', 'pm')"
    ).run();
    const pmToken = await signDevJwt('pm@example.com', {
      audience: 'a'.repeat(64),
      sub: 'pm-subject'
    });
    const denied = await exports.default.fetch(
      new Request('https://sales.example/api/faqs', {
        method: 'POST',
        headers: { [JWT_HEADER]: pmToken, 'content-type': 'application/json' },
        body: JSON.stringify({
          question: 'What is D1?',
          answer: 'A SQL database.',
          productId: 'd1',
          audience: 'internal'
        })
      })
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('content-type')).toContain('application/problem+json');

    await testEnv.DB.prepare(
      "INSERT INTO identities (identity_key, email, role) VALUES ('admin-key', 'admin@example.com', 'administrator')"
    ).run();
    const adminToken = await signDevJwt('admin@example.com', { audience: 'a'.repeat(64) });
    const accepted = await exports.default.fetch(
      new Request('https://sales.example/api/faqs', {
        method: 'POST',
        headers: { [JWT_HEADER]: adminToken, 'content-type': 'application/json' },
        body: JSON.stringify({
          question: 'What is D1?',
          answer: 'A SQL database.',
          productId: 'd1',
          audience: 'internal'
        })
      })
    );
    expect(accepted.status).toBe(201);
    const body = (await accepted.json()) as {
      faq: { id: string; expiresAt: string; revision: number };
    };
    expect(body.faq.expiresAt).toMatch(/^202[67]-/u);
    expect(body.faq.revision).toBe(1);
  });

  it('does not expose an internal FAQ to a default salesperson before index cleanup', async () => {
    await testEnv.DB.prepare(
      "INSERT OR IGNORE INTO identities (identity_key, email, role) VALUES ('admin-two', 'admin-two@example.com', 'administrator')"
    ).run();
    const adminToken = await signDevJwt('admin-two@example.com', { audience: 'a'.repeat(64) });
    const created = await exports.default.fetch(
      new Request('https://sales.example/api/faqs', {
        method: 'POST',
        headers: { [JWT_HEADER]: adminToken, 'content-type': 'application/json' },
        body: JSON.stringify({
          question: 'Expired restricted answer?',
          answer: 'Do not return this.',
          productId: 'd1',
          audience: 'internal',
          expiresAt: '2000-01-01T00:00:00.000Z'
        })
      })
    );
    expect(created.status).toBe(201);
    const salespersonToken = await signDevJwt('salesperson@example.com', {
      audience: 'a'.repeat(64)
    });
    const response = await request('/api/faqs', salespersonToken);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ faqs: [] });
  });

  it('keeps documentation import and index freshness administrator-only', async () => {
    const pmToken = await signDevJwt('pm@example.com', { audience: 'a'.repeat(64) });
    const denied = await exports.default.fetch(
      new Request('https://sales.example/api/admin/documentation/import', {
        method: 'POST',
        headers: { [JWT_HEADER]: pmToken, 'content-type': 'application/json' },
        body: '{}'
      })
    );
    expect(denied.status).toBe(403);

    const adminToken = await signDevJwt('admin@example.com', { audience: 'a'.repeat(64) });
    const imported = await exports.default.fetch(
      new Request('https://sales.example/api/admin/documentation/import', {
        method: 'POST',
        headers: { [JWT_HEADER]: adminToken, 'content-type': 'application/json' },
        body: '{}'
      })
    );
    expect(imported.status).toBe(200);
    const sources = await request('/api/admin/documentation', adminToken);
    expect(sources.status).toBe(200);
    expect(((await sources.json()) as { sources: unknown[] }).sources.length).toBeGreaterThan(0);
  });
});
