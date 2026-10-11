/**
 * @file The deployed Application Worker entry (`src/application-worker/index.ts`) composed with a
 *   `DATA_SERVICE` binding whose transport fails: the caller gets a retryable RFC 9457 `503` with
 *   no internal detail, and the failure is logged once as a structured record naming the dependency
 *   — without a stack trace or the raw error object. Also the per-request actor cache.
 */

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';
import { actorOf, type ApiEnv } from '../../../src/application-worker/api/context.ts';
import worker from '../../../src/application-worker/index.ts';
import type { DataService } from '../../../src/shared/data-service/contract.ts';
import { createFakeDataService } from '../../fakes/fake-data-service.ts';

const AUD = 'a'.repeat(64);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Application Worker entry', () => {
  it('maps a broken Data Worker binding to a safe 503 and logs the transport failure', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(
          args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
        );
      });
    }
    const broken = {
      health: () => Promise.reject(new Error('connection reset: secret-internal-host:4433'))
    };
    const response = await worker.request(
      'https://crm.example/api/v1/health',
      // Vitest builds with `import.meta.env.DEV`, so the entry accepts a development token here; a
      // production build compiles that path out.
      { headers: { [JWT_HEADER]: await signDevJwt('owner@example.com', { audience: AUD }) } },
      { DATA_SERVICE: broken, ACCESS_AUD: AUD, ENVIRONMENT: 'production' }
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
    const body = await response.text();
    expect(body).toContain('DEPENDENCY_FAILURE');
    expect(body).not.toContain('secret-internal-host');
    expect(body).not.toContain('"stack"');
    const logged = lines.find((line) => line.includes('data service transport failure'));
    expect(logged).toBeDefined();
    expect(logged).toContain('DATA_SERVICE');
    expect(logged).not.toContain('    at ');

    // A non-Error rejection (some transports reject with a string) is logged as text too.
    lines.length = 0;
    const odd = await worker.request(
      'https://crm.example/api/v1/health',
      { headers: { [JWT_HEADER]: await signDevJwt('owner@example.com', { audience: AUD }) } },
      {
        DATA_SERVICE: { health: () => Promise.reject('socket closed') },
        ACCESS_AUD: AUD,
        ENVIRONMENT: 'production'
      }
    );
    expect(odd.status).toBe(503);
    expect(lines.find((line) => line.includes('data service transport failure'))).toContain(
      'socket closed'
    );
  });
});

describe('actorOf', () => {
  it('resolves the verified identity once per request, however many times it is asked', async () => {
    const { service } = createFakeDataService();
    const resolveActor = vi.fn<DataService['resolveActor']>((email) =>
      Promise.resolve({
        email,
        userId: '00000000-0000-4000-8000-000000000001',
        displayName: 'Owner',
        status: 'active'
      })
    );
    const data: DataService = { ...service, resolveActor };
    const app = new Hono<ApiEnv>();
    app.use(async (context, next) => {
      context.set('requestId', 'req-1');
      context.set('data', data);
      context.set('Cloudflare_Access_Identity', {
        email: 'owner@example.com',
        sub: 'test',
        source: 'header'
      });
      await next();
    });
    app.get('/', async (context) => {
      const first = await actorOf(context);
      const second = await actorOf(context);
      return context.json({ same: first === second, actor: first });
    });
    const body = (await (await app.request('/')).json()) as { same: boolean; actor: unknown };
    expect(body.same).toBe(true);
    expect(body.actor).toEqual({
      email: 'owner@example.com',
      userId: '00000000-0000-4000-8000-000000000001',
      requestId: 'req-1',
      channel: 'api'
    });
    expect(resolveActor).toHaveBeenCalledOnce();
    expect(resolveActor).toHaveBeenCalledWith('owner@example.com', 'req-1');
  });
});
