/**
 * Provides the Phase 1 Worker placeholder until the GraphQL transport is introduced.
 *
 * @returns A 501 response that prevents the infrastructure scaffold from presenting an
 * implemented API before the GraphQL schema exists.
 */
async function fetch(): Promise<Response> {
  return new Response("SWAPI GraphQL is not implemented yet.", { status: 501 });
}

export default { fetch };
