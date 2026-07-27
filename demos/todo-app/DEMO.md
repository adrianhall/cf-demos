# Demo: Personalized TODO App

> **Status:** Phases 1 and 2 of `docs/02-TODO-APP.md` are complete. The hostname and `/api/*`
> are now Access-protected. The full TODO workflow, D1 schema, and presenter flow arrive in
> Phases 3–5.

## Access Demonstration

After deployment, open `https://tasks.cfapps.uk`. Cloudflare Access requires a sign-in through
any enabled identity provider before serving the SPA shell. API requests are independently
validated by the Worker, which makes the verified Access identity available to later TODO routes
without accepting client-supplied user identifiers.

For local development, `npm start` presents a local Access login page with the selectable
identities `alice@example.com` and `bob@example.com`. Use the visible **Sign out** link to clear
the local or production Access session.

## What Will Be Demonstrated (Once Complete)

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
