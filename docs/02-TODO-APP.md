# Demo 2: Personalized TODO App

Directory: `demos/todo-app`

Domain: `todo.cfapps.uk`

Cloudflare products: Workers, Cloudflare Access, and D1.

## Behavior

- Provide a UI for managing a TODO list, a la todomvc
- Use the authenticated user to ensure users don't see each others tasks

## Demo Flow

1. Create a todo, check it off, delete it.
2. Open Workers Logs and locate the informational usage log.
3. Use the D1 console to do SQL queries
