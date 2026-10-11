/**
 * @file `/api/v1` contact and company routes. Handlers stay thin: parse with the shared schema →
 *   resolve the actor → call the Data Worker → check the response against the shared schema.
 *   Authorization is the Data Worker's job; the API never decides access itself.
 */

import { Hono } from 'hono';
import { jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import {
  CompanyPageSchema,
  CompanySchema,
  ContactPageSchema,
  ContactSchema,
  CreateCompanyInputSchema,
  CreateContactInputSchema,
  DashboardSchema,
  ListQuerySchema,
  UpdateCompanyInputSchema,
  UpdateContactInputSchema
} from '../../../shared/api/crm.ts';
import { CompanyDetailSchema, ContactDetailSchema } from '../../../shared/api/customer.ts';
import { CompanyOverviewSchema, ContactOverviewSchema } from '../../../shared/api/overview.ts';
import { DEFAULT_PAGE_SIZE } from '../../../shared/common/paging.ts';
import type { ListOptions } from '../../../shared/data-service/contract.ts';
import { companyOverview, contactOverview } from '../../overview/customer-overview.ts';
import { actorOf, type ApiContext, type ApiEnv } from '../context.ts';
import { expectedVersion, mutationMeta, pathId } from '../preconditions.ts';
import { checkResponse, parseRequest } from '../problems.ts';

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

  router.patch('/contacts/:id', jsonBodyLimit(), async (context) => {
    const id = pathId(context);
    const meta = mutationMeta(context);
    const version = expectedVersion(context);
    const input = parseRequest(
      UpdateContactInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const contact = checkResponse(
      ContactSchema,
      await context.get('data').crm.updateContact(actor, id, input, version, meta)
    );
    context.header('ETag', `"${contact.version}"`);
    return context.json(contact);
  });

  router.get('/contacts/:id/overview', async (context) => {
    const id = pathId(context);
    const actor = await actorOf(context);
    const overview = checkResponse(
      ContactOverviewSchema,
      await contactOverview(context.get('data'), actor, id)
    );
    context.header('ETag', `"${overview.detail.contact.version}"`);
    return context.json(overview);
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

  router.get('/companies/:id/overview', async (context) => {
    const id = pathId(context);
    const actor = await actorOf(context);
    const overview = checkResponse(
      CompanyOverviewSchema,
      await companyOverview(context.get('data'), actor, id)
    );
    context.header('ETag', `"${overview.detail.company.version}"`);
    return context.json(overview);
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
