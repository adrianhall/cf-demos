/**
 * @file `/api/v1` sales routes: pipeline, assignees, deals, activities, contact next actions, the
 *   action stream, and the pipeline report. Handlers stay thin: parse with the shared schema →
 *   resolve the actor → call the Data Worker → check the response against the shared schema.
 *   Authorization is the Data Worker's job.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import { jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import { UserRefSchema } from '../../../shared/api/crm.ts';
import {
  ActionStreamSchema,
  ActivitySchema,
  ContactNextActionSchema,
  CreateActivityInputSchema,
  CreateDealInputSchema,
  DealDetailSchema,
  DealListQuerySchema,
  DealPageSchema,
  DealSchema,
  PipelineSchema,
  SetNextActionInputSchema,
  UpdateDealInputSchema
} from '../../../shared/api/sales.ts';
import { IdSchema } from '../../../shared/common/ids.ts';
import { DEFAULT_PAGE_SIZE } from '../../../shared/common/paging.ts';
import { actorOf, type ApiContext, type ApiEnv } from '../context.ts';
import { checkResponse, parseRequest } from '../problems.ts';
import { expectedVersion, mutationMeta } from './crm.ts';

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
 * Read an optional `If-Match` header for an upsert: present means "replace this version", absent
 * means "create; I believe there is none".
 *
 * @param context Request context.
 * @returns The version, or `null` when the header is absent.
 * @throws {ProblemDetailsError} `422` when present but malformed.
 */
function optionalVersion(context: ApiContext): number | null {
  return context.req.header('If-Match') === undefined ? null : expectedVersion(context);
}

/**
 * Build the sales router mounted at `/api/v1`.
 *
 * @returns The router.
 */
export function salesRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/pipeline', async (context) => {
    const actor = await actorOf(context);
    return context.json(
      checkResponse(PipelineSchema, await context.get('data').crm.getPipeline(actor))
    );
  });

  router.get('/assignees', async (context) => {
    const actor = await actorOf(context);
    return context.json(
      checkResponse(v.array(UserRefSchema), await context.get('data').crm.listAssignees(actor))
    );
  });

  router.get('/deals', async (context) => {
    const query = parseRequest(
      DealListQuerySchema,
      context.req.query(),
      context.get('requestId'),
      'query'
    );
    const actor = await actorOf(context);
    const page = await context.get('data').crm.listDeals(actor, {
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor })
    });
    return context.json(checkResponse(DealPageSchema, page));
  });

  router.post('/deals', jsonBodyLimit(), async (context) => {
    const meta = mutationMeta(context);
    const input = parseRequest(
      CreateDealInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const deal = checkResponse(
      DealSchema,
      await context.get('data').crm.createDeal(actor, input, meta)
    );
    context.header('Location', `/api/v1/deals/${deal.id}`);
    context.header('ETag', `"${deal.version}"`);
    return context.json(deal, 201);
  });

  router.get('/deals/:id', async (context) => {
    const id = pathId(context);
    const actor = await actorOf(context);
    const detail = checkResponse(
      DealDetailSchema,
      await context.get('data').crm.getDeal(actor, id)
    );
    context.header('ETag', `"${detail.deal.version}"`);
    return context.json(detail);
  });

  router.patch('/deals/:id', jsonBodyLimit(), async (context) => {
    const id = pathId(context);
    const meta = mutationMeta(context);
    const version = expectedVersion(context);
    const input = parseRequest(
      UpdateDealInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const deal = checkResponse(
      DealSchema,
      await context.get('data').crm.updateDeal(actor, id, input, version, meta)
    );
    context.header('ETag', `"${deal.version}"`);
    return context.json(deal);
  });

  router.post('/activities', jsonBodyLimit(), async (context) => {
    const meta = mutationMeta(context);
    const input = parseRequest(
      CreateActivityInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const activity = checkResponse(
      ActivitySchema,
      await context.get('data').crm.createActivity(actor, input, meta)
    );
    return context.json(activity, 201);
  });

  router.put('/contacts/:id/next-action', jsonBodyLimit(), async (context) => {
    const id = pathId(context);
    const meta = mutationMeta(context);
    const version = optionalVersion(context);
    const input = parseRequest(
      SetNextActionInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const action = checkResponse(
      ContactNextActionSchema,
      await context.get('data').crm.setContactNextAction(actor, id, input, version, meta)
    );
    context.header('ETag', `"${action.version}"`);
    return context.json(action);
  });

  router.post('/contacts/:id/next-action/complete', async (context) => {
    const id = pathId(context);
    const meta = mutationMeta(context);
    const version = expectedVersion(context);
    const actor = await actorOf(context);
    return context.json(
      checkResponse(
        ContactNextActionSchema,
        await context.get('data').crm.completeContactNextAction(actor, id, version, meta)
      )
    );
  });

  router.get('/action-stream', async (context) => {
    const actor = await actorOf(context);
    return context.json(
      checkResponse(ActionStreamSchema, await context.get('data').crm.actionStream(actor))
    );
  });

  return router;
}
