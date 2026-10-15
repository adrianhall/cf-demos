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
});
