/**
 * @file Shared wire schemas: what every tier accepts and rejects.
 */

import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIGURATION,
  loadConfiguration,
  toDisplayConfiguration
} from '../../../src/configuration.ts';
import { DisplayConfigurationSchema } from '../../../src/shared/api/configuration.ts';
import {
  CreateCompanyInputSchema,
  CreateContactInputSchema,
  ListQuerySchema,
  UpdateCompanyInputSchema
} from '../../../src/shared/api/crm.ts';
import { ProblemSchema } from '../../../src/shared/api/problems.ts';
import { DateOnlySchema, TimestampSchema, toTimestamp } from '../../../src/shared/common/dates.ts';
import { isServiceError, serviceError } from '../../../src/shared/common/errors.ts';
import { IdSchema } from '../../../src/shared/common/ids.ts';
import { PageRequestSchema } from '../../../src/shared/common/paging.ts';
import {
  IdempotencyKeySchema,
  OptionalHttpsUrlSchema
} from '../../../src/shared/validation/fields.ts';
import { issueFields } from '../../../src/shared/validation/issues.ts';

describe('identifiers and dates', () => {
  it('accepts a lowercase UUID and rejects other spellings', () => {
    const id = crypto.randomUUID();
    expect(v.is(IdSchema, id)).toBe(true);
    expect(v.is(IdSchema, id.toUpperCase())).toBe(false);
    expect(v.is(IdSchema, 'not-a-uuid')).toBe(false);
  });

  it('accepts real calendar dates and UTC timestamps only', () => {
    expect(v.is(DateOnlySchema, '2026-02-28')).toBe(true);
    expect(v.is(DateOnlySchema, '2026-02-30')).toBe(false);
    expect(v.is(TimestampSchema, toTimestamp(new Date('2026-10-01T00:00:00Z')))).toBe(true);
    expect(v.is(TimestampSchema, '2026-10-01T00:00:00+01:00')).toBe(false);
  });
});

describe('paging and search', () => {
  it('defaults the page size and bounds it', () => {
    expect(v.parse(PageRequestSchema, {})).toEqual({ limit: 25 });
    expect(v.is(PageRequestSchema, { limit: 101 })).toBe(false);
    expect(v.is(PageRequestSchema, { limit: 0 })).toBe(false);
  });

  it('parses query-string limits and rejects invalid ones', () => {
    expect(v.parse(ListQuerySchema, { q: '  ada ', limit: '10' })).toEqual({ q: 'ada', limit: 10 });
    expect(v.is(ListQuerySchema, { limit: '1000' })).toBe(false);
    expect(v.is(ListQuerySchema, { limit: 'ten' })).toBe(false);
    expect(v.is(ListQuerySchema, { q: '   ' })).toBe(false);
    expect(v.is(ListQuerySchema, { q: 'x'.repeat(101) })).toBe(false);
    expect(v.is(ListQuerySchema, { cursor: 'has spaces' })).toBe(false);
    expect(v.is(ListQuerySchema, { unexpected: '1' })).toBe(false);
  });
});

describe('contact and company input', () => {
  it('normalises blanks to null and lower-cases e-mail', () => {
    expect(
      v.parse(CreateContactInputSchema, {
        firstName: ' Ada ',
        email: ' ADA@EXAMPLE.COM ',
        phone: ''
      })
    ).toEqual({
      firstName: 'Ada',
      lastName: null,
      email: 'ada@example.com',
      phone: null,
      jobTitle: null,
      companyId: null,
      companyName: null
    });
  });

  it('requires a name or a company, reported against firstName', () => {
    const result = v.safeParse(CreateContactInputSchema, { email: 'x@example.com' });
    expect(result.success).toBe(false);
    expect(issueFields(result.issues ?? [])).toEqual({ firstName: 'Enter a name or a company.' });
  });

  it('refuses both companyId and companyName', () => {
    const result = v.safeParse(CreateContactInputSchema, {
      companyId: crypto.randomUUID(),
      companyName: 'X'
    });
    expect(issueFields(result.issues ?? [])).toHaveProperty('companyName');
  });

  it('rejects identity smuggled into a body', () => {
    expect(v.is(CreateContactInputSchema, { firstName: 'A', ownerId: crypto.randomUUID() })).toBe(
      false
    );
  });

  it('rejects a malformed e-mail', () => {
    expect(v.is(CreateContactInputSchema, { firstName: 'A', email: 'nope' })).toBe(false);
  });

  it('validates company links and symbols', () => {
    expect(
      v.parse(CreateCompanyInputSchema, {
        name: 'Acme',
        stockSymbol: ' lse:acm ',
        companiesHouseUrl:
          'https://find-and-update.company-information.service.gov.uk/company/01234567'
      })
    ).toMatchObject({ stockSymbol: 'LSE:ACM' });
    expect(
      v.is(CreateCompanyInputSchema, {
        name: 'Acme',
        companiesHouseUrl: 'https://example.com/company/1'
      })
    ).toBe(false);
    expect(v.is(CreateCompanyInputSchema, { name: 'Acme', stockSymbol: 'bad symbol!' })).toBe(
      false
    );
    expect(v.is(CreateCompanyInputSchema, { name: '   ' })).toBe(false);
  });

  it('requires at least one field on update', () => {
    expect(v.is(UpdateCompanyInputSchema, {})).toBe(false);
    expect(v.is(UpdateCompanyInputSchema, { primaryContactId: null })).toBe(true);
  });

  it('accepts only https URLs', () => {
    expect(v.parse(OptionalHttpsUrlSchema, '')).toBeNull();
    expect(v.is(OptionalHttpsUrlSchema, 'javascript:alert(1)')).toBe(false);
    expect(v.is(OptionalHttpsUrlSchema, 'http://example.com')).toBe(false);
  });

  it('bounds idempotency keys', () => {
    expect(v.is(IdempotencyKeySchema, 'short')).toBe(false);
    expect(v.is(IdempotencyKeySchema, 'a-valid:key.123')).toBe(true);
    expect(v.is(IdempotencyKeySchema, 'has space in it')).toBe(false);
  });
});

describe('problem details', () => {
  it('accepts RFC 9457 bodies with extensions and rejects malformed ones', () => {
    expect(
      v.is(ProblemSchema, {
        type: 'about:blank',
        status: 409,
        title: 'Conflict',
        code: 'VERSION_MISMATCH',
        extra: 1
      })
    ).toBe(true);
    expect(v.is(ProblemSchema, { type: 'about:blank', status: 200, title: 'OK' })).toBe(false);
    expect(v.is(ProblemSchema, { status: 404, title: 'Not Found' })).toBe(false);
    expect(v.is(ProblemSchema, { type: 'x', status: 400, title: 't', code: 'MADE_UP' })).toBe(
      false
    );
  });
});

describe('service errors', () => {
  it('is recognised by shape, including after a structured clone', () => {
    const error = serviceError('NOT_FOUND', 'Gone', { requestId: 'r1', fields: { id: 'bad' } });
    expect(isServiceError(error)).toBe(true);
    expect(isServiceError({ ...error, name: error.name, code: error.code })).toBe(true);
    expect(error).toMatchObject({ retryable: false, requestId: 'r1', fields: { id: 'bad' } });
    expect(serviceError('DEPENDENCY_FAILURE', 'Down').retryable).toBe(true);
    expect(isServiceError(new Error('plain'))).toBe(false);
    expect(isServiceError({ name: 'ServiceError', code: 'UNKNOWN' })).toBe(false);
    expect(isServiceError(null)).toBe(false);
  });
});

describe('installation configuration', () => {
  it('ships a valid UK default and exposes only display fields', () => {
    expect(loadConfiguration(DEFAULT_CONFIGURATION)).toEqual(DEFAULT_CONFIGURATION);
    expect(v.is(DisplayConfigurationSchema, toDisplayConfiguration(DEFAULT_CONFIGURATION))).toBe(
      true
    );
  });

  it('fails loudly on an invalid edit', () => {
    expect(() => loadConfiguration({ ...DEFAULT_CONFIGURATION, currencyCode: 'pounds' })).toThrow();
    expect(() => loadConfiguration({ ...DEFAULT_CONFIGURATION, weekStartsOn: 3 })).toThrow();
  });
});
