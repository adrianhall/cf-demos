/**
 * Worker entry point.
 *
 * Every binding you drew on the canvas is declared in `cloudflare.config.ts` and reaches this
 * handler on `env`. Run `cf workers types` to generate the matching `Env` type.
 */
export default {
  /**
   * Handles an HTTP request.
   *
   * @param request Incoming request.
   * @returns The response to send back.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response('Hello from Cloudflare Workers!', {
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};
