export interface Env {
  // Bindings will be populated by the scaffold generator in wrangler.toml.
  // See https://developers.cloudflare.com/workers/runtime-apis/bindings/
  [key: string]: unknown;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Hello from Cloudflare Workers!", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};
