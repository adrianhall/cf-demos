# Demo: Personalized TODO App

> **Status:** Phase 1 of `docs/02-TODO-APP.md` only. There is nothing to present yet —
> the Worker has no routes, there is no UI, and Cloudflare Access is not wired in. This
> file will be filled in with the full presenter flow once Phases 2–5 land.

## What will be demonstrated (once complete)

- **Cloudflare Access** gating an entire hostname and providing each request's verified
  user identity to the Worker, with no separate login system.
- **D1** as the per-user data store, with every query scoped to the authenticated
  identity so users can never see or modify each other's tasks.
- **Workers Logs** showing a structured `todo_created` event for real, authorized
  activity.

## Planned demonstration flow

1. Sign in as one identity through Cloudflare Access, create a task, check it off,
   delete it.
2. Open **Workers & Pages → tasks → Logs** in the Cloudflare dashboard and locate the
   `todo_created` log entry from step 1.
3. Open the D1 console for the `tasks-db` database and run a `SELECT` query showing the
   `todos` table scoped by `user_id`.
4. Sign in as a second identity and show that their task list is empty — demonstrating
   the per-user isolation enforced by every `/api/todos` query.

See `docs/02-TODO-APP.md` for the full implementation plan.
