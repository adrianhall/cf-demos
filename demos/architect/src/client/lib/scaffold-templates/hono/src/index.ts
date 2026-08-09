import { Hono } from "hono";

type Bindings = {
  // Bindings will be populated by the scaffold generator in wrangler.toml.
  // See https://developers.cloudflare.com/workers/runtime-apis/bindings/
  [key: string]: unknown;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => {
  return c.text("Hello from Hono on Cloudflare Workers!");
});

app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

export default app;
