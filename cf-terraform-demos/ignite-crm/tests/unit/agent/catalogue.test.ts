import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { presentToolError } from '../../../src/application-worker/agent/errors.ts';
import { permittedTools } from '../../../src/application-worker/agent/permissions.ts';
import {
  READ_TOOL_CATALOGUE,
  TOOL_NAMES,
  WRITE_TOOL_CATALOGUE
} from '../../../src/shared/agent/catalogue.ts';
import { SEED_ROLE_PERMISSIONS, type Role } from '../../../src/shared/permissions.ts';

describe('agent catalogue', () => {
  it('has unique stable names and strict inputs', () => {
    expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
    const search = READ_TOOL_CATALOGUE.find((tool) => tool.name === 'search_customers');
    expect(search).toBeDefined();
    expect(v.safeParse(search!.input, { q: 'Acme', limit: 50 }).success).toBe(true);
    expect(v.safeParse(search!.input, { email: 'attacker@example.com' }).success).toBe(false);
    expect(v.safeParse(search!.input, { q: 'Acme', limit: 51 }).success).toBe(false);
    expect(v.safeParse(search!.input, { Q: 'Acme' }).success).toBe(false);
  });

  it('publishes every mutation with strict approval metadata', () => {
    expect(WRITE_TOOL_CATALOGUE).toHaveLength(14);
    expect(WRITE_TOOL_CATALOGUE.every((tool) => tool.mutates)).toBe(true);
    for (const tool of WRITE_TOOL_CATALOGUE) {
      expect(v.safeParse(tool.input, { idempotencyKey: 'call-1' }).success).toBe(false);
      // No tool ever chooses who it acts as, on any surface.
      for (const field of ['actor', 'actorId', 'userId', 'role', 'roles', 'permissions']) {
        expect(
          v.safeParse(tool.input, { idempotencyKey: 'call-1', [field]: 'spoof' }).success,
          `${tool.name}.${field}`
        ).toBe(false);
      }
    }
    const createNote = WRITE_TOOL_CATALOGUE.find((tool) => tool.name === 'create_note');
    expect(createNote).toBeDefined();
    const noteResult = v.safeParse(createNote!.input, {
      idempotencyKey: 'call-1',
      title: 'Meeting notes',
      markdown: 'Discuss renewal',
      links: [{ type: 'company', id: '00000000-0000-4000-8000-000000000001' }]
    });
    expect(noteResult.success, JSON.stringify(noteResult)).toBe(true);
  });

  it.each(Object.keys(SEED_ROLE_PERMISSIONS) as Role[])('filters tools for %s', (role) => {
    const visible = permittedTools(READ_TOOL_CATALOGUE, SEED_ROLE_PERMISSIONS[role]);
    expect(
      visible.every((tool) =>
        tool.requires.every((permission) => SEED_ROLE_PERMISSIONS[role].includes(permission))
      )
    ).toBe(true);
    expect(visible.some((tool) => tool.name === 'whoami')).toBe(true);
  });

  it('does not enumerate hidden records', () => {
    expect(
      presentToolError({
        name: 'ServiceError',
        code: 'NOT_FOUND',
        message: 'secret customer body',
        retryable: false,
        requestId: 'r1'
      })
    ).toEqual({
      code: 'NOT_FOUND',
      message: 'The requested record is not available.',
      retryable: false,
      requestId: 'r1'
    });
    expect(
      presentToolError({
        name: 'ServiceError',
        code: 'CONFLICT',
        message: 'version',
        retryable: true,
        requestId: 'r2'
      }).message
    ).toContain('changed');
  });
});
