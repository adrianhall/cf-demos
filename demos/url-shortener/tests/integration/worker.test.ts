import { env, exports } from "cloudflare:workers";
import { JWT_HEADER, signDevJwt } from "@adrianhall/cloudflare-toolkit/testing";
import { beforeEach, describe, expect, it } from "vitest";

/** Provided bindings used by the workerd integration suite. */
declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

/** Build an authenticated request for a protected management route. */
async function adminRequest(
  path: string,
  init: RequestInit = {},
): Promise<Request> {
  const token = await signDevJwt("admin@example.com");
  return new Request(`https://link.example${path}`, {
    ...init,
    headers: { [JWT_HEADER]: token, ...init.headers },
  });
}

/** Dispatch a request through the configured Worker. */
async function request(requestValue: Request): Promise<Response> {
  return exports.default.fetch(requestValue);
}

describe("URL shortener Worker", () => {
  beforeEach(async () => {
    let cursor: string | undefined;
    do {
      const page = await env.LINKS.list({ cursor, prefix: "link:" });
      await Promise.all(page.keys.map((key) => env.LINKS.delete(key.name)));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  });

  it.each(["/", "/admin", "/api/links"])(
    "requires Cloudflare Access for %s",
    async (path) => {
      const response = await request(
        new Request(`https://link.example${path}`),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      );
    },
  );

  it("creates, lists, reads, updates, redirects, and deletes a short link", async () => {
    const create = await request(
      await adminRequest("/api/links", {
        body: JSON.stringify({
          destination: "https://customer.example.com/welcome",
        }),
        method: "POST",
      }),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { link: { code: string } };

    const list = await request(await adminRequest("/api/links"));
    expect(
      (await list.json()) as { links: Array<{ code: string }> },
    ).toMatchObject({ links: [{ code: created.link.code }] });

    const read = await request(
      await adminRequest(`/api/links/${created.link.code}`),
    );
    expect(read.status).toBe(200);
    expect((await read.json()) as { link: { code: string } }).toMatchObject({
      link: { code: created.link.code },
    });

    const update = await request(
      await adminRequest(`/api/links/${created.link.code}`, {
        body: JSON.stringify({
          destination: "https://customer.example.com/updated",
        }),
        method: "PUT",
      }),
    );
    expect(update.status).toBe(200);

    // `ENVIRONMENT=test` (see vitest.config.ts) resolves the toolkit's "test" logging
    // policy — a capture transport, not console — so the `short_link_used` event this
    // redirect emits isn't observable through a `console.log` spy here. Coverage of the
    // event's shape and the toolkit's environment-driven transport selection belongs to
    // `@adrianhall/cloudflare-toolkit`'s own test suite, not this Worker's.
    const redirect = await request(
      new Request(`https://link.example/l/${created.link.code}`, {
        redirect: "manual",
      }),
    );
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(
      "https://customer.example.com/updated",
    );
    expect(redirect.headers.get("cache-control")).toBe("no-store");

    const deletion = await request(
      await adminRequest(`/api/links/${created.link.code}`, {
        method: "DELETE",
      }),
    );
    expect(deletion.status).toBe(204);

    const missing = await request(
      new Request(`https://link.example/l/${created.link.code}`, {
        redirect: "manual",
      }),
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("rejects unsafe destinations", async () => {
    const response = await request(
      await adminRequest("/api/links", {
        body: JSON.stringify({ destination: "data:text/html,unsafe" }),
        method: "POST",
      }),
    );
    expect(response.status).toBe(422);
  });
});
