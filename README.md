# Demo Scripts

This repository contains several demo scripts. See the Available Demos section of this document for
details.

## Prerequisites

You must have the following already (installed globally where appropriate):

1. A Cloudflare account with the Cloudflare Developer Platform products required by the demos
   (including R2, if used)
2. At least one DNS zone hosted on Cloudflare
3. Node.js 26 or newer
4. pnpm 12.6.0 or newer

Some demos will have additional requirements.

## Getting Started

Install the dependencies and run the environment setup script:

```bash
pnpm install
pnpm create-env
```

`pnpm create-env` checks whether the local `cf` CLI is authenticated. If it is not, the script runs
`cf auth login`, which opens a browser-based Cloudflare login. The script then lists the zones
available to the authenticated user. If more than one zone is available, it prompts you to choose
one. It also prompts for an administrator email, pre-filled with the email associated with the
authenticated Cloudflare account.

The script creates a personalized `.env` containing the selected account ID, zone name, zone ID,
Zero Trust team domain (when available), and administrator email. It deliberately leaves
`CLOUDFLARE_API_TOKEN` as `<from-dashboard>` because API-token creation requires dashboard access
and appropriate permissions. The script does not create or discover an API token.

After `pnpm create-env` completes, log in to the
[Cloudflare dashboard](https://dash.cloudflare.com/) and create a custom API token. The exact
dashboard labels can vary by account and dashboard version, but generally:

1. Open your profile menu and select **API Tokens**.
2. Select **Create Token**, then choose **Create Custom Token** or **Start from scratch**.
3. Scope the token to the account and zone selected by `pnpm create-env`.
4. Grant the permissions required by the demos you intend to run. The baseline permissions
   documented in [`.env.example`](.env.example) are:
   - **Account**: AI Gateway — Edit
   - **Account**: D1 — Edit
   - **Account**: Workers AI — Edit
   - **Account**: Workers KV Storage — Edit
   - **Account**: Workers Scripts — Edit
   - **Account**: Workers R2 Storage — Edit
   - **Account**: Access — Edit
   - **Account**: Access: Identity Providers — Read
   - **Zone**: DNS — Edit
5. Choose an expiration date if desired, then create the token.
6. Copy the token value into `CLOUDFLARE_API_TOKEN` in `.env`.

Additional demos may require additional permissions, such as Queues or AI Search. Do not grant
permissions for products you do not intend to use.

## Available Demos

The following demos are available:

### link - a URL Shortener

| Services | [Workers], [Workers KV Storage], [Access] | | Implementations |
[Plain](./cf-terraform-demos/link), [vinext](./vinext-demos/link) |

Provides a link shortening service with a public front page and an authenticated admin panel.

### todo - a Task List

| Services | [Workers], [D1], [Access] | | Implementations | [Plain](./cf-terraform-demos/todo),
[vinext](./vinext-demos/todo) |

A personalized todo app with authenticated usage.

### swapi - Star Wars API

| Services | [Workers], [D1], [Access] | | Implementations | [Plain](./cf-terraform-demos/swapi),
[vinext](./vinext-demos/swapi) |

An implementation of the Star Wars API [GraphQL] service with [GraphiQL].

## chat - An Enterprise Chat system

| Services | [Workers], [D1], [Durable Objects], [Access] | | Implementations |
[Plain](./cf-terraform-demos/chat), [vinext](./vinext-demos/chat) |

## playground - An AI model playground

| Services | [Workers], [Workers AI], [AI Gateway], [Access] | | Implementations |
[Plain](./cf-terraform-demos/playground) |

A playground for AI model task types where every inference request is routed through AI Gateway and
its reported cost is shown to the user who caused it. Being unable to bypass the gateway is enforced
by a build-failing test, not by convention.

<!-- Links -->

[Access]: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
[AI Gateway]: https://developers.cloudflare.com/ai-gateway/
[D1]: https://developers.cloudflare.com/d1/
[Durable Objects]: https://developers.cloudflare.com/durable-objects/
[Workers]: https://developers.cloudflare.com/workers/
[Workers AI]: https://developers.cloudflare.com/workers-ai/
[Workers KV Storage]: https://developers.cloudflare.com/kv/
[GraphQL]: https://graphql.org/
[GraphiQL]: https://github.com/graphql/graphiql/tree/main/packages/graphiql
