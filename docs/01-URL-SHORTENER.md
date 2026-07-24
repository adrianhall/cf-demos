# Demo 1: URL Shortener

Directory: `demos/url-shortener`

Domain: `link.cfapps.uk`

Cloudflare products: Workers and Workers KV.

## Behavior

- Provide an admin page for creating, editing, and deleting short links.
- Redirect `https://link.cfapps.uk/l/<code>` to the configured destination.
- Write an informational structured log whenever a short link is used.

## Demo Flow

1. Create a short link to a customer website in the admin page.
2. Open the generated short URL and observe the redirect.
3. Open Workers Logs and locate the informational usage log.
