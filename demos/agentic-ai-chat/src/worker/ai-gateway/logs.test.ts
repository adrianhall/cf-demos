import { describe, expect, it, vi } from "vitest";
import { findLogByCorrelationId } from "./logs";

/** Build a fake `fetchImpl` resolving to a JSON response with the given status/body. */
function fakeFetch(
  status: number,
  body: unknown,
): (url: URL, init: RequestInit) => Promise<Response> {
  return vi.fn(async () => Response.json(body, { status }));
}

describe("findLogByCorrelationId", () => {
  it("returns the matching log's mapped figures when the logs-list endpoint reports one row", async () => {
    const fetchImpl = fakeFetch(200, {
      success: true,
      result: [
        {
          id: "log-1",
          model: "@cf/google/gemma-4-26b-a4b-it",
          tokens_in: 12,
          tokens_out: 34,
          cost: 0.000_045,
        },
      ],
    });

    const match = await findLogByCorrelationId("corr-1", {
      accountId: "account-1",
      gatewayId: "gateway-1",
      apiToken: "token-1",
      fetchImpl,
    });

    expect(match).toEqual({
      gatewayLogId: "log-1",
      model: "@cf/google/gemma-4-26b-a4b-it",
      tokensIn: 12,
      tokensOut: 34,
      costUsd: 0.000_045,
    });
  });

  it("sends the correlation id as a single JSON-encoded metadata.value filter, not bracket notation", async () => {
    const fetchImpl = fakeFetch(200, { success: true, result: [] });

    await findLogByCorrelationId("corr-1", {
      accountId: "account-1",
      gatewayId: "gateway-1",
      apiToken: "token-1",
      fetchImpl,
    });

    const [url] = vi.mocked(fetchImpl).mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe(
      "/client/v4/accounts/account-1/ai-gateway/gateways/gateway-1/logs",
    );
    expect(url.searchParams.get("filters")).toBe(
      JSON.stringify([
        { key: "metadata.value", operator: "eq", value: ["corr-1"] },
      ]),
    );
  });

  it("sends the API token as a bearer Authorization header", async () => {
    const fetchImpl = fakeFetch(200, { success: true, result: [] });

    await findLogByCorrelationId("corr-1", {
      accountId: "account-1",
      gatewayId: "gateway-1",
      apiToken: "secret-token",
      fetchImpl,
    });

    const [, init] = vi.mocked(fetchImpl).mock.calls[0] as [URL, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-token",
    );
  });

  it("returns null when the endpoint reports zero matching rows (the not-yet-available signal)", async () => {
    const fetchImpl = fakeFetch(200, { success: true, result: [] });

    const match = await findLogByCorrelationId("corr-1", {
      accountId: "account-1",
      gatewayId: "gateway-1",
      apiToken: "token-1",
      fetchImpl,
    });

    expect(match).toBeNull();
  });

  it("returns null when the response omits the result field entirely", async () => {
    const fetchImpl = fakeFetch(200, { success: true });

    const match = await findLogByCorrelationId("corr-1", {
      accountId: "account-1",
      gatewayId: "gateway-1",
      apiToken: "token-1",
      fetchImpl,
    });

    expect(match).toBeNull();
  });

  it("defaults missing tokens_in/tokens_out/cost to 0 rather than undefined", async () => {
    const fetchImpl = fakeFetch(200, {
      success: true,
      result: [{ id: "log-failed", model: "dynamic/agentic-chat-basic" }],
    });

    const match = await findLogByCorrelationId("corr-1", {
      accountId: "account-1",
      gatewayId: "gateway-1",
      apiToken: "token-1",
      fetchImpl,
    });

    expect(match).toEqual({
      gatewayLogId: "log-failed",
      model: "dynamic/agentic-chat-basic",
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    });
  });

  it("throws when the HTTP response itself is not ok", async () => {
    const fetchImpl = fakeFetch(401, { success: false, errors: ["bad token"] });

    await expect(
      findLogByCorrelationId("corr-1", {
        accountId: "account-1",
        gatewayId: "gateway-1",
        apiToken: "bad-token",
        fetchImpl,
      }),
    ).rejects.toThrow(/status 401/);
  });

  it("throws when the response body itself reports success: false", async () => {
    const fetchImpl = fakeFetch(200, {
      success: false,
      errors: [{ message: "gateway not found" }],
    });

    await expect(
      findLogByCorrelationId("corr-1", {
        accountId: "account-1",
        gatewayId: "gateway-1",
        apiToken: "token-1",
        fetchImpl,
      }),
    ).rejects.toThrow(/reported failure/);
  });
});
