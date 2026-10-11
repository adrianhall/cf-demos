/**
 * @file `/api/v1` delivery routes: won-deal conversion, projects, tasks, and the personal worklist.
 *   Handlers stay thin: parse with the shared schema → resolve the actor → call the Data Worker →
 *   check the response against the shared schema. Authorization and the atomic conversion are the
 *   Data Worker's job (see `src/data-worker/application/projects/projects-service.ts`).
 */

import { Hono } from 'hono';
import { jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import {
  ConvertDealInputSchema,
  CreateTaskInputSchema,
  MyWorkSchema,
  ProjectDetailSchema,
  ProjectListQuerySchema,
  ProjectPageSchema,
  ProjectSchema,
  TaskSchema,
  UpdateProjectInputSchema,
  UpdateTaskInputSchema
} from '../../../shared/api/projects.ts';
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
 * Read an optional JSON body: an empty body is `{}` (conversion's fields are all optional).
 *
 * @param context Request context.
 * @returns The parsed body.
 * @throws {ProblemDetailsError} `400` for malformed JSON.
 */
async function optionalJsonBody(context: ApiContext): Promise<unknown> {
  const hasBody =
    context.req.raw.body !== null && (context.req.header('Content-Length') ?? '') !== '0';
  return hasBody ? readJsonBody(context.req.raw) : {};
}

/**
 * Build the delivery router mounted at `/api/v1`.
 *
 * @returns The router.
 */
export function projectsRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.post('/deals/:id/convert', jsonBodyLimit(), async (context) => {
    const id = pathId(context);
    const meta = mutationMeta(context);
    const version = expectedVersion(context);
    const input = parseRequest(
      ConvertDealInputSchema,
      await optionalJsonBody(context),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const project = checkResponse(
      ProjectSchema,
      await context.get('data').projects.convertDeal(actor, id, input, version, meta)
    );
    context.header('Location', `/api/v1/projects/${project.id}`);
    context.header('ETag', `"${project.version}"`);
    return context.json(project, 201);
  });

  router.get('/projects', async (context) => {
    const query = parseRequest(
      ProjectListQuerySchema,
      context.req.query(),
      context.get('requestId'),
      'query'
    );
    const actor = await actorOf(context);
    const page = await context.get('data').projects.listProjects(actor, {
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor })
    });
    return context.json(checkResponse(ProjectPageSchema, page));
  });

  router.get('/projects/:id', async (context) => {
    const id = pathId(context);
    const actor = await actorOf(context);
    const detail = checkResponse(
      ProjectDetailSchema,
      await context.get('data').projects.getProject(actor, id)
    );
    context.header('ETag', `"${detail.project.version}"`);
    return context.json(detail);
  });

  router.patch('/projects/:id', jsonBodyLimit(), async (context) => {
    const id = pathId(context);
    const meta = mutationMeta(context);
    const version = expectedVersion(context);
    const input = parseRequest(
      UpdateProjectInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const project = checkResponse(
      ProjectSchema,
      await context.get('data').projects.updateProject(actor, id, input, version, meta)
    );
    context.header('ETag', `"${project.version}"`);
    return context.json(project);
  });

  router.post('/projects/:id/tasks', jsonBodyLimit(), async (context) => {
    const id = pathId(context);
    const meta = mutationMeta(context);
    const input = parseRequest(
      CreateTaskInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const task = checkResponse(
      TaskSchema,
      await context.get('data').projects.createTask(actor, id, input, meta)
    );
    context.header('ETag', `"${task.version}"`);
    return context.json(task, 201);
  });

  router.patch('/tasks/:id', jsonBodyLimit(), async (context) => {
    const id = pathId(context);
    const meta = mutationMeta(context);
    const version = expectedVersion(context);
    const input = parseRequest(
      UpdateTaskInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const task = checkResponse(
      TaskSchema,
      await context.get('data').projects.updateTask(actor, id, input, version, meta)
    );
    context.header('ETag', `"${task.version}"`);
    return context.json(task);
  });

  router.get('/my-work', async (context) => {
    const actor = await actorOf(context);
    return context.json(
      checkResponse(MyWorkSchema, await context.get('data').projects.myWork(actor))
    );
  });

  return router;
}
