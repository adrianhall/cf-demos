/**
 * @file `/api/v1` notes routes: list (optionally by linked record), search, read, create, and
 *   update. Handlers stay thin: parse with the shared schema → resolve the actor → call the Data
 *   Worker → check the response against the shared schema. Link validation, authorization, and the
 *   atomic note write are the Data Worker's job (see
 *   `src/data-worker/application/notes/notes-service.ts`).
 *
 *   ## Why search is a POST
 *
 *   Search is read-only, but its text is note content in all but name ("the Contoso pricing
 *   dispute"). A query string would land in browser history, `Referer` headers, and request logs; a
 *   JSON body does not. `POST /notes/search` therefore takes `{ q }` and needs no
 *   `Idempotency-Key`, because it changes nothing.
 */

import { Hono } from 'hono';
import { jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import {
  CreateNoteInputSchema,
  NoteDetailSchema,
  NoteListQuerySchema,
  NotePageSchema,
  NoteSchema,
  NoteSearchQuerySchema,
  NoteSearchResultSchema,
  UpdateNoteInputSchema
} from '../../../shared/api/notes.ts';
import { IdSchema } from '../../../shared/common/ids.ts';
import { DEFAULT_PAGE_SIZE } from '../../../shared/common/paging.ts';
import { actorOf, type ApiContext, type ApiEnv } from '../context.ts';
import { checkResponse, parseRequest } from '../problems.ts';
import { expectedVersion, mutationMeta } from './crm.ts';

/**
 * Largest note request body. The Markdown limit is 64 KiB of UTF-8, but JSON can escape one control
 * byte as six ASCII bytes. 512 KiB allows even that worst case plus title and links; the Data
 * Worker enforces the actual 64 KiB Markdown limit.
 */
export const NOTE_BODY_LIMIT_BYTES = 512 * 1024;

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
 * Build the notes router mounted at `/api/v1`.
 *
 * @returns The router.
 */
export function notesRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.get('/notes', async (context) => {
    const query = parseRequest(
      NoteListQuerySchema,
      context.req.query(),
      context.get('requestId'),
      'query'
    );
    const actor = await actorOf(context);
    const page = await context.get('data').notes.listNotes(actor, {
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
      ...(query.linkType === undefined ? {} : { linkType: query.linkType }),
      ...(query.linkId === undefined ? {} : { linkId: query.linkId }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor })
    });
    return context.json(checkResponse(NotePageSchema, page));
  });

  router.post('/notes/search', jsonBodyLimit(), async (context) => {
    const { q } = parseRequest(
      NoteSearchQuerySchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    return context.json(
      checkResponse(NoteSearchResultSchema, await context.get('data').notes.searchNotes(actor, q))
    );
  });

  router.get('/notes/:id', async (context) => {
    const id = pathId(context);
    const actor = await actorOf(context);
    const detail = checkResponse(
      NoteDetailSchema,
      await context.get('data').notes.getNote(actor, id)
    );
    context.header('ETag', `"${detail.note.version}"`);
    return context.json(detail);
  });

  router.post('/notes', jsonBodyLimit(NOTE_BODY_LIMIT_BYTES), async (context) => {
    const meta = mutationMeta(context);
    const input = parseRequest(
      CreateNoteInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const note = checkResponse(
      NoteSchema,
      await context.get('data').notes.createNote(actor, input, meta)
    );
    context.header('Location', `/api/v1/notes/${note.id}`);
    context.header('ETag', `"${note.version}"`);
    return context.json(note, 201);
  });

  router.patch('/notes/:id', jsonBodyLimit(NOTE_BODY_LIMIT_BYTES), async (context) => {
    const id = pathId(context);
    const meta = mutationMeta(context);
    const version = expectedVersion(context);
    const input = parseRequest(
      UpdateNoteInputSchema,
      await readJsonBody(context.req.raw),
      context.get('requestId'),
      'body'
    );
    const actor = await actorOf(context);
    const note = checkResponse(
      NoteSchema,
      await context.get('data').notes.updateNote(actor, id, input, version, meta)
    );
    context.header('ETag', `"${note.version}"`);
    return context.json(note);
  });

  return router;
}
