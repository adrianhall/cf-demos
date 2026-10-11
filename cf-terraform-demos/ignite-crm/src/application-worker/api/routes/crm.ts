/**
 * @file `/api/v1` contact and company routes. Handlers stay thin: parse with the shared schema →
 *   resolve the actor → call the Data Worker → check the response against the shared schema.
 *   Authorization is the Data Worker's job; the API never decides access itself.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import { preconditionRequired } from '@adrianhall/cloudflare-toolkit/errors';
import { jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import {
  CompanyDetailSchema,
  CompanyPageSchema,
  CompanySchema,
  ContactDetailSchema,
  ContactPageSchema,
  ContactSchema,
  CreateCompanyInputSchema,
  CreateContactInputSchema,
  DashboardSchema,
  ListQuerySchema,
  UpdateCompanyInputSchema
} from '../../../shared/api/crm.ts';
import { IdSchema } from '../../../shared/common/ids.ts';
import { DEFAULT_PAGE_SIZE } from '../../../shared/common/paging.ts';
import type { ListOptions, MutationMeta } from '../../../shared/data-service/contract.ts';
import { IdempotencyKeySchema } from '../../../shared/validation/fields.ts';
import { actorOf, type ApiContext, type ApiEnv } from '../context.ts';
import { checkResponse, parseRequest } from '../problems.ts';

/**
 * Schema for an `If-Match` header carrying a weak or strong numeric version ETag.
 */
const IfMatchSchema = v.pipe(
  v.string(),
  v.regex(/^(?:W\/)?"\d{1,9}"$/u, 'If-Match must be a version ETag such as "3".'),
  v.transform((value) => Number(value.replace(/^W\//u, '').replaceAll('"', ''))),
  v.minValue(1)
);

/**
 * Read the mandatory `Idempotency-Key` header.
 *
 * @param context Request context.
 * @returns Mutation metadata.
 * @throws {ProblemDetailsError} `428` when absent, `422` when malformed.
 */
export function mutationMeta(context: ApiContext): MutationMeta {
  const header = context.req.header('Idempotency-Key');
  if (header === undefined) {
    throw preconditionRequired({
      detail: 'Mutations require an Idempotency-Key header.',
      extensions: { requestId: context.get('requestId') }
    });
  }
  return {
    idempotencyKey: parseRequest(IdempotencyKeySchema, header, context.get('requestId'), 'query')
  };
}

/**
 * Read the mandatory `If-Match` header.
 *
 * @param context Request context.
 * @returns The expected version.
 * @throws {ProblemDetailsError} `428` when absent, `422` when malformed.
 */
export function expectedVersion(context: ApiContext): number {
  const header = context.req.header('If-Match');
  if (header === undefined) {
    throw preconditionRequired({
      detail: 'Updates require an If-Match header with the version you last read.',
      extensions: { requestId: context.get('requestId') }
    });
  }
  return parseRequest(IfMatchSchema, header, context.get('requestId'), 'query');
}

/**
 * Parse list query parameters.
 *
 * @param context Request context.
 * @returns List options.
 * @throws {ProblemDetailsError} `422` for invalid parameters.
 */
function listOptions(context: ApiContext): ListOptions {
  const query = parseRequest(
    ListQuerySchema,
    context.req.query(),
    context.get('requestId'),
    'query'
  );
  return {
    limit: query.limit ?? DEFAULT_PAGE_SIZE,
    ...(query.q === undefined ? {} : { q: query.q }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor })
  };
}

/**
 * Parse an `:id` path parameter.
 *
 * @param context Request context.
 * @returns The identifier.
 * @throws {ProblemDetailsError} `422` when it is not a lowercase UUID.
 */
function pathId(context: ApiContext): string {
  return parseRequest(IdSchema, context.req.param('id'), context.get('requestId'), 'path');
}

/**
 * Build the CRM router mounted at `/api/v1`.
 *
 * @returns The router.
 */
export function crmRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/dashboard', async (context) => {
    const actor = await actorOf(context);
    return context.json(
      checkResponse(DashboardSchema, await context.get('data').crm.dashboard(actor))
    );
  });

  router.get('/contacts', async (context) => {
    const options = listOptions(context);
    const actor = await actorOf(context);
    return context.json(
      checkResponse(ContactPageSchema, await context.get('data').crm.listContacts(actor, options))
    );
  });

  router.post('/contacts', jsonBodyLimit(), async (context) => {
    const meta = mutationMeta(context);
    const input = parseRequest(
      CreateContactInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const contact = checkResponse(
      ContactSchema,
      await context.get('data').crm.createContact(actor, input, meta)
    );
    context.header('Location', `/api/v1/contacts/${contact.id}`);
    context.header('ETag', `"${contact.version}"`);
    return context.json(contact, 201);
  });

  router.get('/contacts/:id', async (context) => {
    const id = pathId(context);
    const actor = await actorOf(context);
    const detail = checkResponse(
      ContactDetailSchema,
      await context.get('data').crm.getContact(actor, id)
    );
    context.header('ETag', `"${detail.contact.version}"`);
    return context.json(detail);
  });

  router.get('/companies', async (context) => {
    const options = listOptions(context);
    const actor = await actorOf(context);
    return context.json(
      checkResponse(CompanyPageSchema, await context.get('data').crm.listCompanies(actor, options))
    );
  });

  router.post('/companies', jsonBodyLimit(), async (context) => {
    const meta = mutationMeta(context);
    const input = parseRequest(
      CreateCompanyInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const company = checkResponse(
      CompanySchema,
      await context.get('data').crm.createCompany(actor, input, meta)
    );
    context.header('Location', `/api/v1/companies/${company.id}`);
    context.header('ETag', `"${company.version}"`);
    return context.json(company, 201);
  });

  router.get('/companies/:id', async (context) => {
    const id = pathId(context);
    const actor = await actorOf(context);
    const detail = checkResponse(
      CompanyDetailSchema,
      await context.get('data').crm.getCompany(actor, id)
    );
    context.header('ETag', `"${detail.company.version}"`);
    return context.json(detail);
  });

  router.patch('/companies/:id', jsonBodyLimit(), async (context) => {
    const id = pathId(context);
    const meta = mutationMeta(context);
    const version = expectedVersion(context);
    const input = parseRequest(
      UpdateCompanyInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const company = checkResponse(
      CompanySchema,
      await context.get('data').crm.updateCompany(actor, id, input, version, meta)
    );
    context.header('ETag', `"${company.version}"`);
    return context.json(company);
  });

  return router;
}
