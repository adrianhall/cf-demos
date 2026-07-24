import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppBindings } from "../bindings";
import { loggerMiddleware, resolveLevel } from "./logger";

/**
 * Build a minimal `Env` fixture for {@link resolveLevel}. Only `ENVIRONMENT`/`LOG_LEVEL`
 * matter to the function under test — the cast stands in for the many unrelated required
 * bindings (`LINKS`, `ASSETS`, `CLOUDFLARE_TEAM_DOMAIN`, ...) a real `Env` also carries.
 */
function makeEnv(overrides: { ENVIRONMENT?: string; LOG_LEVEL?: string }): Env {
  return { ENVIRONMENT: "", LOG_LEVEL: "", ...overrides } as Env;
}

describe("resolveLevel", () => {
  it("honors an explicit, recognized LOG_LEVEL regardless of ENVIRONMENT", () => {
    expect(
      resolveLevel(makeEnv({ ENVIRONMENT: "production", LOG_LEVEL: "trace" })),
    ).toBe("trace");
  });

  it("ignores an unrecognized LOG_LEVEL and falls back to the ENVIRONMENT default", () => {
    expect(
      resolveLevel(
        makeEnv({ ENVIRONMENT: "production", LOG_LEVEL: "verbose" }),
      ),
    ).toBe("info");
  });

  it.each([
    ["development", "debug"],
    ["production", "info"],
    ["test", "trace"],
  ] as const)(
    "defaults ENVIRONMENT=%s to level %s when LOG_LEVEL is unset",
    (environment, level) => {
      expect(
        resolveLevel(makeEnv({ ENVIRONMENT: environment, LOG_LEVEL: "" })),
      ).toBe(level);
    },
  );

  it('falls back to "info" for an unrecognized or missing ENVIRONMENT', () => {
    expect(
      resolveLevel(makeEnv({ ENVIRONMENT: "staging", LOG_LEVEL: "" })),
    ).toBe("info");
    expect(resolveLevel(makeEnv({ ENVIRONMENT: "", LOG_LEVEL: "" }))).toBe(
      "info",
    );
  });
});

describe("loggerMiddleware", () => {
  it("attaches a working Logger to the context and calls next()", async () => {
    const app = new Hono<AppBindings>();
    app.use(loggerMiddleware);
    app.get("/", (context) => {
      const logger = context.get("LOGGER");
      expect(typeof logger.info).toBe("function");
      // ENVIRONMENT="test" resolves the toolkit's capture transport, so this doesn't
      // spam the test run's real console/stderr output.
      logger.info("unit-test-message");
      return context.text("ok");
    });

    const response = await app.request(
      "/",
      {},
      makeEnv({ ENVIRONMENT: "test", LOG_LEVEL: "" }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
