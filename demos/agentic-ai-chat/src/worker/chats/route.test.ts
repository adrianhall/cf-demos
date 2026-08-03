import { describe, expect, it } from "vitest";
import {
  CHAT_ROUTES,
  DEFAULT_CHAT_ROUTE,
  isChatRoute,
  resolveDynamicRouteModelId,
} from "./route";

describe("isChatRoute", () => {
  it("accepts exactly the two valid route literals", () => {
    expect(isChatRoute("basic")).toBe(true);
    expect(isChatRoute("reasoning")).toBe(true);
  });

  it("rejects anything else, including a raw model id or a close-but-wrong string", () => {
    expect(isChatRoute("Basic")).toBe(false);
    expect(isChatRoute("@cf/google/gemma-4-26b-a4b-it")).toBe(false);
    expect(isChatRoute("dynamic/agentic-chat-basic")).toBe(false);
    expect(isChatRoute(null)).toBe(false);
    expect(isChatRoute(undefined)).toBe(false);
    expect(isChatRoute(42)).toBe(false);
    expect(isChatRoute("")).toBe(false);
  });
});

describe("CHAT_ROUTES / DEFAULT_CHAT_ROUTE", () => {
  it("lists both routes, basic first, matching the UI dropdown's intended order", () => {
    expect(CHAT_ROUTES).toEqual(["basic", "reasoning"]);
  });

  it("defaults to basic", () => {
    expect(DEFAULT_CHAT_ROUTE).toBe("basic");
  });
});

describe("resolveDynamicRouteModelId", () => {
  const env = {
    AI_GATEWAY_ROUTE_BASIC: "agentic-chat-basic",
    AI_GATEWAY_ROUTE_REASONING: "agentic-chat-reasoning",
  };

  it("resolves 'basic' to the dynamic/<name> form of the basic route's real name", () => {
    expect(resolveDynamicRouteModelId("basic", env)).toBe(
      "dynamic/agentic-chat-basic",
    );
  });

  it("resolves 'reasoning' to the dynamic/<name> form of the reasoning route's real name", () => {
    expect(resolveDynamicRouteModelId("reasoning", env)).toBe(
      "dynamic/agentic-chat-reasoning",
    );
  });

  it("never interpolates anything from env other than the two named route vars", () => {
    const modelId = resolveDynamicRouteModelId("basic", {
      AI_GATEWAY_ROUTE_BASIC: "renamed-route",
      AI_GATEWAY_ROUTE_REASONING: "unused-for-this-call",
    });
    expect(modelId).toBe("dynamic/renamed-route");
  });
});
