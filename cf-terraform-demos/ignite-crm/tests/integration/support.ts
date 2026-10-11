/**
 * @file Shared helpers for the Workers-runtime suites.
 */

import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

/**
 * Audience the Worker under test accepts.
 */
export const AUD = 'a'.repeat(64);

/**
 * Origin used for every request.
 */
export const ORIGIN = 'https://ignite-crm.example';

/**
 * Apply the committed migrations to the isolated test database.
 *
 * @returns Once the schema exists.
 */
export async function migrate(): Promise<void> {
  await applyD1Migrations(env.DATA_DB, env.TEST_MIGRATIONS);
}

/**
 * Seed a user with one role directly, as the local seed script would.
 *
 * @param email User e-mail.
 * @param role Role to grant.
 * @param status Account status.
 * @returns The user id.
 */
export async function seedUser(
  email: string,
  role: string,
  status: 'active' | 'suspended' = 'active'
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DATA_DB.batch([
    env.DATA_DB.prepare(
      `INSERT INTO users (id, email, display_name, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`
    ).bind(id, email, email.split('@')[0] ?? email, status, now, now),
    env.DATA_DB.prepare(
      'INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)'
    ).bind(id, role, now)
  ]);
  return id;
}

/**
 * Options for {@link api}.
 */
export interface ApiOptions extends RequestInit {
  /**
   * Identity to sign a development token for; omit for an unauthenticated request.
   */
  readonly as?: string;
  /**
   * Audience to sign for (defaults to the accepted one).
   */
  readonly audience?: string;
  /**
   * Token lifetime in seconds (negative mints an expired token).
   */
  readonly lifetime?: number;
  /**
   * JSON body.
   */
  readonly json?: unknown;
}

/**
 * Call the Application Worker.
 *
 * @param path Request path.
 * @param options Identity, body, and request options.
 * @returns The response.
 */
export async function api(path: string, options: ApiOptions = {}): Promise<Response> {
  const { as, audience, lifetime, json, ...init } = options;
  const headers = new Headers(init.headers);
  if (as !== undefined) {
    headers.set(
      JWT_HEADER,
      await signDevJwt(as, {
        audience: audience ?? AUD,
        ...(lifetime === undefined ? {} : { lifetime })
      })
    );
  }
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (init.method !== undefined && init.method !== 'GET' && !headers.has('Origin')) {
    headers.set('Origin', ORIGIN);
  }
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, {
      ...init,
      headers,
      ...(json === undefined ? {} : { body: JSON.stringify(json) })
    })
  );
}
