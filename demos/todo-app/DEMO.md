# Personalized TODO App Demo Guide

## Purpose

This demo shows one Cloudflare Worker serving a Vue TODO interface and Hono API, while Cloudflare Access supplies the identity used to scope D1 data on every request.

## Cloudflare Capabilities

- **Workers** serves the SPA and authenticated API from one service at `tasks.cfapps.uk`.
- **Cloudflare Access** gates the hostname and exposes a verified identity without a separate application login system.
- **D1** persists TODOs, with every list, read-before-update, update, and delete scoped to the Access identity email.
- **Workers Logs and traces** expose successful TODO creation activity.

## Demonstration Prerequisites

1. Deploy from `demos/todo-app` with `npm run deploy`.
2. Confirm the presenter can authenticate through an enabled Access identity provider.
3. Open **Workers & Pages → tasks → Logs** in a second browser window.
4. Open the `tasks-db` D1 database in the Cloudflare dashboard.

## Presentation Flow

1. Open `https://tasks.cfapps.uk` in a signed-out browser and show Cloudflare Access requiring authentication before the SPA renders.
2. Sign in, create a TODO, mark it complete, and delete it from the task list.
3. In Workers Logs, locate the `todo_created`, `todo_completed`, `todo_uncompleted`,
   `todo_removed`, or `completed_todos_removed` informational event. Point out that per-item
   events contain a task UUID but no task text, identity data, tokens, or authorization headers.
4. In the D1 console for `tasks-db`, run:

   ```sql
   SELECT id, user_id, title, completed, created_at, updated_at
   FROM todos
   ORDER BY created_at DESC;
   ```

5. Use the always-visible **Sign out** control. Sign in as a second identity and show an empty list. Explain that the Worker derives `user_id` from the verified Access JWT rather than accepting it from the browser.

## Expected Results

- Unauthenticated navigation is intercepted by Access, and unauthenticated `/api/*` requests return `401` problem details.
- An authenticated user can create, complete, and delete only their own TODOs.
- A second authenticated user cannot list, update, or delete the first user's TODOs.
- Each successful TODO mutation produces its matching informational log event.

## Where To Observe State

- **Worker logs:** Workers & Pages → `tasks` → Logs; filter for a TODO mutation event.
- **Traces:** Workers & Pages → `tasks` → Observability → Traces; sampling is 10%.
- **D1 data:** D1 → `tasks-db` → Console; query the `todos` table as shown above.
- **Access application:** Zero Trust → Access controls → Applications → `tasks`.

## Local Demonstration

Run `npm start` and open the local Vite address. The development-only Access plugin offers `alice@example.com` and `bob@example.com`; the same visible **Sign out** control clears the local session. Local D1 data is stored in `.wrangler/` and does not touch the deployed database.

## Cleanup

Run `npm run teardown` from `demos/todo-app` after the presentation. It removes the Access application and policy, custom domain, Worker, and D1 database.
