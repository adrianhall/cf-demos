import { badRequest } from "@adrianhall/cloudflare-toolkit/errors";
import { Hono } from "hono";
import type { AppBindings } from "../bindings";
import { TodoRepository } from "../todos/repository";
import {
  validateCreateTodoInput,
  validateTodoId,
  validateUpdateTodoInput,
} from "../todos/validation";

/** Authenticated per-user TODO API mounted at `/api/todos`. */
export const todosRouter = new Hono<AppBindings>();

/** Parse JSON request content and map malformed bodies to RFC 9457 bad requests. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw badRequest({ detail: "Request body must contain valid JSON." });
  }
}

/** List only the TODOs belonging to the verified Access identity. */
todosRouter.get("/", async (context) => {
  const userId = context.get("Cloudflare_Access_Identity").email;
  const repository = new TodoRepository(context.env.DB);
  return context.json({ todos: await repository.list(userId) });
});

/** Create a TODO for the verified Access identity. */
todosRouter.post("/", async (context) => {
  const userId = context.get("Cloudflare_Access_Identity").email;
  const input = validateCreateTodoInput(await readJson(context.req.raw));
  const repository = new TodoRepository(context.env.DB);
  const todo = await repository.create(userId, input);
  context.get("LOGGER").info("todo_created", { todoId: todo.id });
  return context.json({ todo }, 201);
});

/** Rename and/or toggle a TODO owned by the verified Access identity. */
todosRouter.patch("/:id", async (context) => {
  const userId = context.get("Cloudflare_Access_Identity").email;
  const input = validateUpdateTodoInput(await readJson(context.req.raw));
  const repository = new TodoRepository(context.env.DB);
  const todo = await repository.update(
    userId,
    validateTodoId(context.req.param("id")),
    input,
  );
  if (input.completed !== undefined) {
    context
      .get("LOGGER")
      .info("todo_setstate", { todoId: todo.id, completed: input.completed });
  }
  return context.json({ todo });
});

/** Delete all completed TODOs belonging to the verified Access identity. */
todosRouter.delete("/completed", async (context) => {
  const userId = context.get("Cloudflare_Access_Identity").email;
  const repository = new TodoRepository(context.env.DB);
  await repository.deleteCompleted(userId);
  context.get("LOGGER").info("completed_todos_removed");
  return new Response(null, { status: 204 });
});

/** Delete a TODO owned by the verified Access identity. */
todosRouter.delete("/:id", async (context) => {
  const userId = context.get("Cloudflare_Access_Identity").email;
  const repository = new TodoRepository(context.env.DB);
  const todoId = validateTodoId(context.req.param("id"));
  await repository.delete(userId, todoId);
  context.get("LOGGER").info("todo_removed", { todoId });
  return new Response(null, { status: 204 });
});
