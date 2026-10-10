# SWAPI GraphQL Demo

Prerequisites: deploy the demo with `npm run deploy`, have an identity available from the configured Cloudflare Access identity provider, and sign in to the Cloudflare dashboard for the deployed account.

1. In a browser, open `https://swapi-graphql.cfapps.uk/`, replacing the hostname if this deployment uses a different `DEMO_DOMAIN`; confirm it redirects to `/graphql`.
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

6. Return to **Workers & Pages** > **swapi-graphql** > **Logs** and confirm the nested request prepares two statements: one for films and one batched relationship query.
7. In the Cloudflare dashboard, open **Storage & Databases** > **D1**, select the `swapi-graphql-db` database, and open the console.
8. In the D1 console, run:

   ```sql
   SELECT * FROM film_person LIMIT 10;
   ```

9. Return to GraphiQL and run `{ films { title characters(first: 2) { name } } }` to cap each film's child list without changing the number of D1 statements.
10. In **Workers & Pages** > **swapi-graphql** > **Logs**, open the new `GraphQL request completed` record and confirm the statement count remains constant as result size is bounded.

Expected result: the flat query prepares one D1 statement. The nested film-to-character query prepares two statements regardless of the number of returned films; `first` bounds each parent list. See [EXPLAIN-DEMO.md](./EXPLAIN-DEMO.md) for the batching design.
