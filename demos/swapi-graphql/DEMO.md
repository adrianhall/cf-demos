# SWAPI GraphQL Demo

Prerequisites: deploy the demo with `npm run deploy`, have an identity available from the configured Cloudflare Access identity provider, and sign in to the Cloudflare dashboard for the deployed account.

1. In a browser, open `https://swapi-graphql.cfapps.uk/graphql`, replacing the hostname if this deployment uses a different `DEMO_DOMAIN`.
2. On the Cloudflare Access page, select the configured identity provider and complete sign-in with any available identity.
3. In GraphiQL, run the flat query:

   ```graphql
   { films { title episodeId releaseDate } }
   ```

4. In the Cloudflare dashboard, open **Workers & Pages**, select **swapi-graphql**, then open **Logs**. Find the `GraphQL request completed` record and note its `statementCount`.
5. Return to GraphiQL and run the nested query:

   ```graphql
   {
     films {
       title
       characters {
         name
         homeworld { name }
       }
     }
   }
   ```

6. Return to **Workers & Pages** > **swapi-graphql** > **Logs** and compare the nested request's `statementCount` and `durationMs` with the flat request.
7. In the Cloudflare dashboard, open **Storage & Databases** > **D1**, select the `swapi-graphql-db` database, and open the console.
8. In the D1 console, run:

   ```sql
   SELECT * FROM film_person LIMIT 10;
   ```

9. Return to GraphiQL and rerun the nested query while the relationship rows are visible in the D1 console.
10. In **Workers & Pages** > **swapi-graphql** > **Logs**, open the new `GraphQL request completed` record and use `statementCount` to connect the repeated per-film relationship lookups to the join-table rows.

Expected result: the flat query prepares one D1 statement, while the nested query prepares the films statement, one character query per film, and additional homeworld queries for returned people. See [EXPLAIN-DEMO.md](./EXPLAIN-DEMO.md) for the reason this intentional N+1 behavior differs from a production resolver design.
