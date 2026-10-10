import { describe, expect, it, vi } from "vitest";
import { fetchUrl, type GetUrlDeps } from "./get-url";

/** A minimal `WorkerLoader` double whose `get()` always returns a stub whose entrypoint's
 * `fetch()` resolves to `response`. Mirrors Spike C's own `WorkerStub`/`getEntrypoint()` shape
 * (`spikes/02-dynamic-workers-egress-control/src/tool-runner.ts`), just enough of it for
 * {@link fetchUrl} to drive -- never a real Dynamic Worker or network call. The real
 * `WorkerLoader.get()` only invokes its own `getCode` callback lazily and internally, so this
 * double deliberately never calls it either -- {@link fetchUrl}'s own shaping of that callback's
 * return value is asserted separately, by invoking the captured callback directly. */
function loaderResolvingTo(response: Response): WorkerLoader {
  return {
    get: vi.fn(() => ({
      getEntrypoint: () => ({ fetch: vi.fn(async () => response) }),
      getDurableObjectClass: vi.fn(),
    })),
    // biome-ignore lint/suspicious/noExplicitAny: a minimal test double, not the real WorkerStub interface.
  } as any;
}

/** Base deps for {@link fetchUrl}, overridable per test. `createGlobalOutboundGateway` never
 * needs to return a real `Fetcher` here -- the fake loader above never inspects its
 * `globalOutbound` argument at all. */
function baseDeps(loader: WorkerLoader): GetUrlDeps {
  return {
    loader,
    chatId: "chat-1",
    createGlobalOutboundGateway: vi.fn(() => ({}) as unknown as Fetcher),
  };
}

describe("fetchUrl", () => {
  it("returns the fetched content for a successful, allowed URL", async () => {
    const loader = loaderResolvingTo(
      new Response("<html>hello</html>", { status: 200 }),
    );
    const deps = baseDeps(loader);

    const result = await fetchUrl(deps, {
      url: "https://developers.cloudflare.com/workers/",
    });

    expect(result).toEqual({
      success: true,
      url: "https://developers.cloudflare.com/workers/",
      content: "<html>hello</html>",
    });
    expect(loader.get).toHaveBeenCalledWith(
      "get-url-tool",
      expect.any(Function),
    );
  });

  it("builds the Dynamic Worker's code with this call's own gateway and the sandboxed module", async () => {
    const loader = loaderResolvingTo(new Response("ignored"));
    const deps = baseDeps(loader);

    await fetchUrl(deps, { url: "https://developers.cloudflare.com/workers/" });

    // biome-ignore lint/suspicious/noExplicitAny: a minimal test double's captured mock call.
    const getCode = (loader.get as any).mock.calls[0][1] as () =>
      | WorkerLoaderWorkerCode
      | Promise<WorkerLoaderWorkerCode>;
    const code = await getCode();
    expect(code.mainModule).toBe("index.js");
    expect(Object.keys(code.modules)).toEqual(["index.js"]);
    expect(deps.createGlobalOutboundGateway).toHaveBeenCalledWith({
      chatId: "chat-1",
    });
    expect(code.globalOutbound).toBe(
      (deps.createGlobalOutboundGateway as ReturnType<typeof vi.fn>).mock
        .results[0]?.value,
    );
  });

  it("rejects an invalid URL before ever loading the Dynamic Worker", async () => {
    const loader = loaderResolvingTo(new Response("unused"));
    const deps = baseDeps(loader);

    const result = await fetchUrl(deps, { url: "not a url" });

    expect(result).toEqual({
      success: false,
      blocked: false,
      error: '"not a url" is not a valid absolute URL.',
    });
    expect(loader.get).not.toHaveBeenCalled();
  });

  it("reports a blocked destination distinctly from every other failure shape", async () => {
    const loader = loaderResolvingTo(
      new Response('Egress blocked: "cloudflare.com" is not allow-listed.', {
        status: 403,
      }),
    );
    const deps = baseDeps(loader);

    const result = await fetchUrl(deps, { url: "https://cloudflare.com/" });

    expect(result).toEqual({
      success: false,
      blocked: true,
      error: 'Egress blocked: "cloudflare.com" is not allow-listed.',
    });
  });

  it("reports a generic failure for a non-2xx, non-403 upstream response", async () => {
    const loader = loaderResolvingTo(
      new Response("upstream error", { status: 502 }),
    );
    const deps = baseDeps(loader);

    const result = await fetchUrl(deps, {
      url: "https://developers.cloudflare.com/workers/",
    });

    expect(result).toEqual({
      success: false,
      blocked: false,
      error:
        'Fetching "https://developers.cloudflare.com/workers/" failed (status 502).',
    });
  });

  it("reports a generic failure, never an unhandled exception, when loading the Dynamic Worker itself throws", async () => {
    const loader: WorkerLoader = {
      get: vi.fn(() => {
        throw new Error("simulated Dynamic Worker load failure");
      }),
      // biome-ignore lint/suspicious/noExplicitAny: a minimal test double, not the real WorkerLoader interface.
    } as any;
    const deps = baseDeps(loader);

    const result = await fetchUrl(deps, {
      url: "https://developers.cloudflare.com/workers/",
    });

    expect(result).toEqual({
      success: false,
      blocked: false,
      error: "The URL could not be fetched.",
    });
  });
});
