# Demo #1: The "url shortener"

Domain: "link.cfapps.uk"

Services used:

- Workers
- Workers KV

This demo is about a URL shortener (similar to bit.ly).  It consists of two parts:

1. An admin page for creating, editing, and removing a link
2. A link redirector.

Demo flow:

- User adds a link to the customers website on the admin page.
- The link is available as `https://link.cf.apps.uk/l/<code>`
- Go to the link and see it redirect.
- Go to workers logs and see the info message showing the link was used.
