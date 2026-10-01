import { Hono } from 'hono';
import { currentIdentityEmail, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { AppBindings } from '../bindings';

/**
 * Personal task API, mounted at `/api/todos`.
 *
 * Every route is behind Cloudflare Access (see `../middleware/access.ts`) and scoped to the
 * verified identity by {@link currentIdentityEmail}. No route accepts a user identifier from the
 * request: the owner always comes from the validated JWT, so a caller cannot act on another user's
 * tasks by changing a parameter.
 */
export const todosRouter = new Hono<AppBindings>();

todosRouter.use(jsonBodyLimit());

/**
 * List the signed-in user's tasks.
 *
 * @param context Hono request context providing the verified identity and task service.
 * @returns A JSON `200` response containing that user's tasks, newest first.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {Error} When the repository cannot list tasks.
 */
todosRouter.get('/', async (context) =>
  context.json({
    todos: await context.get('TODO_SERVICE').listTodos(currentIdentityEmail(context))
  })
);

/**
 * Create a task from `{ "title": "..." }`.
 *
 * @param context Hono request context containing the bounded JSON body and task service.
 * @returns A JSON `201` response containing the newly created task.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} When the body is not valid JSON (`400`) or the title is missing,
 *   empty, or too long (`422`).
 * @throws {Error} When the repository cannot store the task.
 */
todosRouter.post('/', async (context) => {
  const todo = await context
    .get('TODO_SERVICE')
    .createTodo(currentIdentityEmail(context), await readJsonBody(context.req.raw));
  // Log the identifier only. The title is user content and the identity is personal data; neither
  // belongs in an observability record that is retained and widely readable.
  context.get('LOGGER').info('todo_created', { todoId: todo.id });
  return context.json({ todo }, 201);
});

/**
 * Delete every completed task belonging to the signed-in user.
 *
 * Declared before `/:id` because Hono matches routes in registration order: registered after, the
 * parameterized route would capture `completed` as an identifier and answer `404`.
 *
 * @param context Hono request context providing the verified identity and task service.
 * @returns An empty `204` response, including when the user had no completed tasks — clearing
 *   nothing is a successful outcome, not an error.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {Error} When the repository cannot delete the tasks.
 */
todosRouter.delete('/completed', async (context) => {
  const cleared = await context
    .get('TODO_SERVICE')
    .clearCompletedTodos(currentIdentityEmail(context));
  context.get('LOGGER').info('completed_todos_removed', { cleared });
  return new Response(null, { status: 204 });
});

/**
 * Rename and/or toggle completion of one of the signed-in user's tasks.
 *
 * @param context Hono request context containing the `id` path parameter and bounded JSON body.
 * @returns A JSON `200` response containing the updated task.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} When the body is invalid (`400`/`422`), or the identifier is
 *   malformed or does not belong to this user (`404` in both cases, so the response cannot confirm
 *   that another user's task exists).
 * @throws {Error} When the repository cannot read or write the task.
 */
todosRouter.patch('/:id', async (context) => {
  const todo = await context
    .get('TODO_SERVICE')
    .updateTodo(
      currentIdentityEmail(context),
      context.req.param('id'),
      await readJsonBody(context.req.raw)
    );
  context.get('LOGGER').info('todo_setstate', {
    todoId: todo.id,
    completed: todo.completed
  });
  return context.json({ todo });
});

/**
 * Delete one of the signed-in user's tasks.
 *
 * @param context Hono request context containing the `id` path parameter and task service.
 * @returns An empty `204` response once the task has been deleted.
 * @throws {NullError} When the route is reached without Access identity verification.
 * @throws {ProblemDetailsError} `notFound()` (404) when the identifier is malformed or does not
 *   belong to this user.
 * @throws {Error} When the repository cannot delete the task.
 */
todosRouter.delete('/:id', async (context) => {
  const todoId = context.req.param('id');
  await context.get('TODO_SERVICE').deleteTodo(currentIdentityEmail(context), todoId);
  context.get('LOGGER').info('todo_removed', { todoId });
  return new Response(null, { status: 204 });
});
