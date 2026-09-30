import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { JWT_HEADER, signDevJwt } from '@adrianhall/cloudflare-toolkit/testing';

/**
 * Audience the Worker is configured to accept, matching `ACCESS_AUD` in `./vitest.config.ts`.
 */
const AUD = 'a'.repeat(64);

/**
 * A GraphQL response body. `data` is typed loosely because each test asserts on its own shape.
 */
interface GraphQLResponse {
  /**
   * Selected data, absent when execution failed outright.
   */
  data?: Record<string, unknown>;
  /**
   * Errors raised during validation or execution.
   */
  errors?: { message: string }[];
}

/**
 * Dispatch a request through the Worker under test.
 *
 * @param request Request to dispatch.
 * @returns The Worker's response.
 */
function send(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

/**
 * Build a request carrying a development Access JWT.
 *
 * `redirect: 'manual'` is the default here because two of this Worker's behaviours are redirects
 * (`/` to the console, and an unauthenticated page navigation to a login form). Without it the
 * runtime follows them transparently and the assertion sees the final `200`, which would hide a
 * change of redirect target or status entirely.
 *
 * @param path Path to request.
 * @param init Additional request options.
 * @param options Token options: the identity to sign for and the audience to mint against. The
 *   audience defaults to the one the Worker accepts; a test overrides it to prove cross-application
 *   tokens are refused.
 * @returns A request ready to dispatch.
 */
async function authenticated(
  path: string,
  init: RequestInit = {},
  options: { email?: string; audience?: string } = {}
): Promise<Request> {
  const token = await signDevJwt(options.email ?? 'alice@example.com', {
    audience: options.audience ?? AUD
  });
  const headers = new Headers(init.headers);
  headers.set(JWT_HEADER, token);
  return new Request(`https://swapi.example${path}`, { redirect: 'manual', ...init, headers });
}

/**
 * Execute a GraphQL operation as an authenticated identity.
 *
 * @param query GraphQL document to execute.
 * @param options Token options forwarded to {@link authenticated}.
 * @returns The parsed GraphQL response body.
 */
async function graphql(
  query: string,
  options: { email?: string; audience?: string } = {}
): Promise<GraphQLResponse> {
  const response = await send(
    await authenticated(
      '/graphql',
      {
        method: 'POST',
        body: JSON.stringify({ query }),
        headers: { 'Content-Type': 'application/json' }
      },
      options
    )
  );
  return (await response.json()) as GraphQLResponse;
}

describe('authorization', () => {
  it('refuses an unauthenticated GraphQL request', async () => {
    const response = await send(
      new Request('https://swapi.example/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: '{ films { title } }' }),
        headers: { 'Content-Type': 'application/json' }
      })
    );

    expect(response.status).toBe(401);
  });

  it('reports an unauthenticated failure as RFC 9457 problem details', async () => {
    const response = await send(new Request('https://swapi.example/graphql', { method: 'POST' }));

    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
  });

  it('refuses an unauthenticated page navigation', async () => {
    const response = await send(new Request('https://swapi.example/'));

    expect(response.status).toBe(401);
  });

  it('refuses a token minted for a different Access application in the same team', async () => {
    // Every application in a Cloudflare Access team shares one JWKS, so this token's signature is
    // perfectly valid. Only the audience check rejects it, which is the defence that makes
    // edge-level Access gating non-load-bearing on its own.
    const response = await send(
      await authenticated('/graphql', { method: 'POST' }, { audience: 'b'.repeat(64) })
    );

    expect(response.status).toBe(401);
  });

  it('admits any authenticated team identity, since the dataset is the same for everyone', async () => {
    const alice = await graphql('{ films { title } }', { email: 'alice@example.com' });
    const bob = await graphql('{ films { title } }', { email: 'bob@example.com' });

    // Unlike the sibling `todo` demo there is no per-identity data boundary here: authentication
    // bounds who may spend the endpoint's compute, not what they can see.
    expect(alice.data?.films).toEqual(bob.data?.films);
  });
});

describe('routing', () => {
  it('leaves the root for Vinext to render', async () => {
    const response = await send(await authenticated('/'));

    // In production Vinext's App Router entrypoint answers `/` with the React explorer and never
    // reaches this Hono application: only `app/api/me/route.ts` and `app/graphql/route.ts`
    // delegate here. This suite mounts the Hono application directly, so `/` correctly falls
    // through to its RFC 9457 not-found handler. What matters is that it is not claimed by
    // anything here — in particular it does not redirect to GraphiQL, which would make the
    // explorer unreachable.
    expect(response.status).toBe(404);
  });

  it('keeps GraphiQL at its dedicated path rather than claiming the root', async () => {
    const response = await send(await authenticated('/'));

    expect(response.headers.get('Location')).not.toBe('/graphql');
  });

  it('returns the runtime native Response, not a ponyfilled one', async () => {
    // GraphQL Yoga bundles a WHATWG fetch ponyfill and prefers it unless given the runtime's
    // globals via `fetchAPI` (see `src/worker/routes/graphql.ts`). A `PonyfillResponse` fails the
    // Workers runtime's own `instanceof Response` check, and every request then dies with
    // "the Promise did not resolve to 'Response'".
    //
    // Honest caveat: this assertion documents the invariant but does not by itself reproduce that
    // failure. Removing `fetchAPI` breaks `cf dev` immediately while this suite still passes,
    // because the Vitest Workers pool resolves Yoga's dependencies differently from the Vite dev
    // SSR pipeline. The bug was found by running `pnpm start` and requesting the endpoint, which is
    // the check that actually catches it — see the README's "Verify locally" steps.
    const response = await send(
      await authenticated('/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: '{ films { title } }' }),
        headers: { 'Content-Type': 'application/json' }
      })
    );

    expect(response instanceof Response).toBe(true);
    expect(response.constructor.name).toBe('Response');
  });

  it('serves the GraphiQL console for a browser GET', async () => {
    const response = await send(
      await authenticated('/graphql', { headers: { Accept: 'text/html' } })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toContain('graphiql');
  });

  it('answers an unknown path with problem details rather than HTML', async () => {
    const response = await send(await authenticated('/not-a-route'));

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('application/problem+json');
  });
});

describe('queries', () => {
  it('returns every film in saga order', async () => {
    const body = await graphql('{ films { title episodeId } }');
    const films = body.data?.films as { title: string; episodeId: string }[];

    expect(films).toHaveLength(6);
    expect(films.map((film) => film.episodeId)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('returns the seeded scalar values for a known film', async () => {
    const body = await graphql('{ films { title director releaseDate } }');
    const films = body.data?.films as { title: string; director: string; releaseDate: string }[];
    const newHope = films.find((film) => film.title === 'A New Hope');

    expect(newHope).toEqual({
      title: 'A New Hope',
      director: 'George Lucas',
      releaseDate: '1977-05-25'
    });
  });

  it('lists the other five collections', async () => {
    const body = await graphql(`
      {
        people {
          id
        }
        planets {
          id
        }
        speciesList {
          id
        }
        starships {
          id
        }
        vehicles {
          id
        }
      }
    `);

    for (const key of ['people', 'planets', 'speciesList', 'starships', 'vehicles']) {
      expect((body.data?.[key] as unknown[]).length, `${key} should be seeded`).toBeGreaterThan(0);
    }
  });

  it('looks up one entity by identifier', async () => {
    const list = await graphql('{ planets { id name } }');
    const [planet] = list.data?.planets as { id: string; name: string }[];

    const single = await graphql(`{ planet(id: "${planet.id}") { id name } }`);

    expect(single.data?.planet).toEqual(planet);
  });

  it('resolves an unknown identifier to null rather than an error', async () => {
    const body = await graphql('{ film(id: "00000000-0000-4000-8000-000000000000") { title } }');

    expect(body.data?.film).toBeNull();
    expect(body.errors).toBeUndefined();
  });
});

describe('relations', () => {
  it('traverses a many-to-many relation', async () => {
    const body = await graphql('{ films { title characters { name } } }');
    const films = body.data?.films as { title: string; characters: { name: string }[] }[];
    const newHope = films.find((film) => film.title === 'A New Hope');

    expect(newHope?.characters.length).toBeGreaterThan(0);
    expect(newHope?.characters.map((character) => character.name)).toContain('Luke Skywalker');
  });

  it('orders a relation deterministically', async () => {
    const body = await graphql('{ films { characters { name } } }');
    const films = body.data?.films as { characters: { name: string }[] }[];
    const names = films[0].characters.map((character) => character.name);

    expect(names).toEqual(names.toSorted());
  });

  it('resolves a single-valued foreign-key relation', async () => {
    const body = await graphql('{ people { name homeworld { name } } }');
    const people = body.data?.people as { name: string; homeworld: { name: string } | null }[];
    const luke = people.find((person) => person.name === 'Luke Skywalker');

    expect(luke?.homeworld?.name).toBe('Tatooine');
  });

  it('resolves a null single-valued relation without erroring', async () => {
    // Some characters have no recorded species. That is a gap in the dataset, not a failure.
    const body = await graphql('{ people { name species { name } } }');
    const people = body.data?.people as { species: { name: string } | null }[];

    expect(body.errors).toBeUndefined();
    expect(people.some((person) => person.species === null)).toBe(true);
  });

  it('traverses a relation in the reverse direction', async () => {
    // `Planet.residents` is the inverse of `Person.homeworld`, resolved by a different SQL shape.
    const body = await graphql('{ planets { name residents { name } } }');
    const planets = body.data?.planets as { name: string; residents: { name: string }[] }[];
    const tatooine = planets.find((planet) => planet.name === 'Tatooine');

    expect(tatooine?.residents.map((resident) => resident.name)).toContain('Luke Skywalker');
  });

  it('follows the relation cycle back to the starting type', async () => {
    const body = await graphql('{ films { title characters { name films { title } } } }');

    expect(body.errors).toBeUndefined();
    const films = body.data?.films as {
      title: string;
      characters: { films: { title: string }[] }[];
    }[];
    const newHope = films.find((film) => film.title === 'A New Hope');

    // A character in A New Hope must list A New Hope among their films.
    expect(newHope?.characters[0].films.map((film) => film.title)).toContain('A New Hope');
  });

  it('limits a relation per parent rather than across the whole result', async () => {
    const body = await graphql('{ films { title characters(first: 2) { name } } }');
    const films = body.data?.films as { characters: { name: string }[] }[];

    // Every film gets up to two characters. A plain LIMIT would have returned two rows in total.
    expect(films).toHaveLength(6);
    for (const film of films) {
      expect(film.characters.length).toBeLessThanOrEqual(2);
    }
    expect(films.filter((film) => film.characters.length > 0).length).toBeGreaterThan(1);
  });

  it('rejects an out-of-range relation limit', async () => {
    const body = await graphql('{ films { characters(first: 0) { name } } }');

    expect(body.errors?.[0].message).toContain('between 1 and 100');
  });

  it('rejects a relation limit above the supported maximum', async () => {
    const body = await graphql('{ films { characters(first: 5000) { name } } }');

    expect(body.errors?.[0].message).toContain('between 1 and 100');
  });
});

describe('query cost limits', () => {
  it('rejects a query nested beyond the depth limit', async () => {
    // The relation cycle makes unbounded nesting expressible, so the depth limit is what stops a
    // single request from fanning out until the Worker exhausts its CPU budget.
    const body = await graphql(`
      {
        films {
          characters {
            films {
              characters {
                films {
                  characters {
                    films {
                      characters {
                        films {
                          characters {
                            name
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `);

    expect(body.errors).toBeDefined();
  });

  it('rejects a query selecting more fields than the breadth limit allows', async () => {
    const body = await graphql(`
      {
        films {
          characters {
            name
          }
          planets {
            name
          }
          species {
            name
          }
          starships {
            name
          }
          vehicles {
            name
          }
        }
        people {
          films {
            title
          }
          starships {
            name
          }
          vehicles {
            name
          }
          homeworld {
            name
            residents {
              name
              films {
                title
              }
            }
          }
          species {
            name
            people {
              name
            }
            films {
              title
            }
          }
        }
        planets {
          residents {
            name
            films {
              title
            }
          }
          films {
            title
          }
        }
        starships {
          pilots {
            name
            films {
              title
            }
          }
          films {
            title
          }
        }
        vehicles {
          pilots {
            name
            films {
              title
            }
          }
          films {
            title
          }
        }
        speciesList {
          people {
            name
            films {
              title
            }
          }
          films {
            title
          }
          homeworld {
            name
          }
        }
      }
    `);

    expect(body.errors).toBeDefined();
  });

  it('allows the query the console opens with', async () => {
    // The limits must not be so tight that they reject the demo's own default query.
    const body = await graphql(`
      {
        films {
          title
          episodeId
          characters(first: 5) {
            name
            homeworld {
              name
              climate
            }
          }
        }
      }
    `);

    expect(body.errors).toBeUndefined();
    expect((body.data?.films as unknown[]).length).toBe(6);
  });
});

describe('introspection', () => {
  it('serves introspection, which the console depends on', async () => {
    const body = await graphql('{ __schema { queryType { name } } }');

    expect(body.data?.__schema).toEqual({ queryType: { name: 'Query' } });
  });

  it('reports that no mutation type exists', async () => {
    const body = await graphql('{ __schema { mutationType { name } } }');
    const schema = body.data?.__schema as { mutationType: unknown };

    expect(schema.mutationType).toBeNull();
  });

  it('rejects an attempted mutation', async () => {
    const body = await graphql('mutation { createFilm(title: "x") { id } }');

    expect(body.errors).toBeDefined();
    // Null rather than absent: GraphQL reports a failed operation with a null data entry.
    expect(body.data ?? null).toBeNull();
  });
});

describe('error handling', () => {
  it('reports an invalid query as a GraphQL error, not a crash', async () => {
    const body = await graphql('{ films { notARealField } }');

    expect(body.errors?.[0].message).toContain('notARealField');
  });

  it('reports a malformed document as a GraphQL error', async () => {
    const body = await graphql('{ films {');

    expect(body.errors).toBeDefined();
  });
});
