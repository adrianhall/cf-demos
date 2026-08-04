# Demo 8: SWAPI GraphQL Service

Directory: `demos/swapi-graphql`

Domain: `swapi-graphql.cfapps.uk`

Status: Draft

## Goal

Build a GraphQL service using the [StarWars API](https://github.com/SivaramPg/swapi.info/tree/main/public/api) data, using the following technologies:

- [Hono](https://hono.dev) for the entry point of the API
- [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) for the GraphQL service
- [Pothos](https://pothos-graphql.dev/) for the schema
- GraphiQL or Retool for the UI

It will be a code-first schema.  The idea is to provide best practices on how to deal with the graphql service.  Review ~/ai-workspace/swapi-graphql.md for notes.

Notes:

- Make it basic - naive implementation to show off problems in M:N issues
- Produce a read-only service using direct SQL (no Drizzle)
- No authentication (cloudflare-access bypass rule in terraform)
- No subscriptions
- No UI (other than the GraphQL console)
