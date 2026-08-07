/** Serve the built local spike through workerd without any remote bindings. */
export default {
  /** Forward every request to the local static-assets binding. */
  fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
};
