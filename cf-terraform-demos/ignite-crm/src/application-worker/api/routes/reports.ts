/**
 * @file `/api/v1/reports` routes: the pipeline report, the quarterly pipeline report, and the
 *   delivery report. All are reads gated by `report.read` in the Data Worker. Query strings are
 *   parsed with the shared schemas, so an invalid or over-wide filter is a `422` before any RPC is
 *   made. With no query string, the pipeline report is the unfiltered summary the dashboard shows.
 */

import { Hono } from 'hono';
import {
  DeliveryReportFilterSchema,
  DeliveryReportSchema,
  PipelineReportFilterSchema,
  PipelineReportSchema,
  QuarterlyPipelineFilterSchema,
  QuarterlyPipelineReportSchema
} from '../../../shared/api/reports.ts';
import { actorOf, type ApiEnv } from '../context.ts';
import { checkResponse, parseRequest } from '../problems.ts';

/**
 * Drop empty query values so `?ownerId=` means "no filter" rather than an invalid id.
 *
 * @param query Raw query parameters.
 * @returns Non-empty parameters only.
 */
function present(query: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== ''));
}

/**
 * Build the reports router mounted at `/api/v1`.
 *
 * @returns The router.
 */
export function reportsRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/reports/pipeline', async (context) => {
    const filter = parseRequest(
      PipelineReportFilterSchema,
      present(context.req.query()),
      context.get('requestId'),
      'query'
    );
    const actor = await actorOf(context);
    return context.json(
      checkResponse(
        PipelineReportSchema,
        await context.get('data').crm.pipelineReport(actor, filter)
      )
    );
  });

  router.get('/reports/pipeline/quarterly', async (context) => {
    const filter = parseRequest(
      QuarterlyPipelineFilterSchema,
      present(context.req.query()),
      context.get('requestId'),
      'query'
    );
    const actor = await actorOf(context);
    return context.json(
      checkResponse(
        QuarterlyPipelineReportSchema,
        await context.get('data').crm.quarterlyPipeline(actor, filter)
      )
    );
  });

  router.get('/reports/delivery', async (context) => {
    const filter = parseRequest(
      DeliveryReportFilterSchema,
      present(context.req.query()),
      context.get('requestId'),
      'query'
    );
    const actor = await actorOf(context);
    return context.json(
      checkResponse(
        DeliveryReportSchema,
        await context.get('data').projects.deliveryReport(actor, filter)
      )
    );
  });

  return router;
}
