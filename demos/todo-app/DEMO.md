# Tasks Demo Script

See [`EXPLAIN-DEMO.md`](./EXPLAIN-DEMO.md) for what this demo teaches.

## Demonstration Prerequisites

1. Deploy the demo with `npm run deploy` from `demos/todo-app`.
2. Confirm you can authenticate through the configured identity provider as at least two different identities (for example `alice@example.com` and `bob@example.com`, or two real accounts in the target Zero Trust organization).
3. Open a second browser window or tab to the Cloudflare dashboard at **Zero Trust** > **Access controls** > **Applications**.
4. Open a third browser window or tab to the Cloudflare dashboard's **D1** section, ready to open the `tasks-db` database's console.
5. Sign out of, or use a private/incognito window for, the demo hostname so the first step shows the unauthenticated experience.

## Presentation Flow

1. In the signed-out/incognito browser, open `https://tasks.cfapps.uk/`. Show that Cloudflare Access intercepts the request with its login screen before any part of the app renders.
2. Switch to the dashboard tab. Open **Zero Trust** > **Access controls** > **Applications** and show the single application for this demo, covering the whole hostname with an allow policy that requires authentication from any identity in the configured provider — no public bypass.
3. Back in the browser, sign in as the first identity (`alice@example.com`).
4. Create two or three tasks using the input field.
5. Check one task off to mark it complete, and show the completed styling.
6. Delete one of the remaining tasks.
7. Switch to the dashboard tab. Open **Workers & Pages** > `tasks` > **Logs**, and locate the `todo_created` event for the first task you created.
8. Open that log event and point out its `todoId` field, and that it contains no task title, identity data, tokens, or authorization headers.
9. Switch to the D1 tab. Open the `tasks-db` database's console and run:

   ```sql
   SELECT id, user_id, title, completed, created_at, updated_at
   FROM todos
   ORDER BY created_at DESC;
   ```

   Point out the `user_id` column holding Alice's email on every row.
10. Back in the browser, use the always-visible **Sign out** control.
11. Sign in as the second identity (`bob@example.com`).
12. Show the task list is empty — Bob cannot see any of Alice's tasks.
13. Create a task as Bob, then re-run the D1 query from step 9 and show both users' rows in the same table, each scoped by its own `user_id`.

## Expected Results

- Unauthenticated visitors to the hostname see the Cloudflare Access login screen, never the app; unauthenticated `/api/*` requests receive `401`.
- Each signed-in identity can create, complete, and delete only its own tasks.
- Every successful create, completion toggle, or deletion produces its matching informational log event (`todo_created`, `todo_setstate`, `todo_removed`, or `completed_todos_removed`).
- The `todos` table in D1 holds every user's rows together, distinguished only by `user_id`, proving isolation happens in the Worker's queries rather than in separate storage per user.

## Where To Observe State

- **Worker logs:** Workers & Pages > `tasks` > Logs; filter `message` for `todo_created`, `todo_setstate`, `todo_removed`, or `completed_todos_removed`.
- **Traces:** Workers & Pages > `tasks` > Observability > Traces (10% sampling).
- **D1 data:** D1 > `tasks-db` > Console; query the `todos` table as shown above.
- **Access application:** Zero Trust > Access controls > Applications > `tasks`.

Run `npm run teardown` after the presentation; see README.md for details.
