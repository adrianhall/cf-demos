import { beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mount = vi.fn();
  const use = vi.fn();
  return {
    app: { mount, use },
    createApp: vi.fn(() => ({ mount, use })),
    createPinia: vi.fn(() => "pinia"),
    createRouter: vi.fn(() => "router"),
    createVuetify: vi.fn(() => "vuetify"),
    createWebHistory: vi.fn(() => "history"),
    mount,
    use,
  };
});

vi.mock("vue", () => ({ createApp: mocks.createApp }));
vi.mock("pinia", () => ({ createPinia: mocks.createPinia }));
vi.mock("vue-router", () => ({
  createRouter: mocks.createRouter,
  createWebHistory: mocks.createWebHistory,
}));
vi.mock("vuetify", () => ({ createVuetify: mocks.createVuetify }));
vi.mock("vuetify/components", () => ({
  VAlert: "VAlert",
  VApp: "VApp",
  VBtn: "VBtn",
  VCard: "VCard",
  VCardActions: "VCardActions",
  VCardText: "VCardText",
  VChip: "VChip",
  VContainer: "VContainer",
  VDialog: "VDialog",
  VList: "VList",
  VListItem: "VListItem",
  VMain: "VMain",
  VProgressCircular: "VProgressCircular",
  VSpacer: "VSpacer",
  VTextField: "VTextField",
}));
vi.mock("vuetify/directives", () => ({ Ripple: "Ripple" }));
vi.mock("vuetify/styles", () => ({}));
vi.mock("./App.vue", () => ({ default: "App" }));
vi.mock("./views/AdminView.vue", () => ({ default: "AdminView" }));

let startClient: typeof import("./main").startClient;

beforeAll(async () => {
  window.history.replaceState({}, "", "/admin");
  ({ startClient } = await import("./main"));
});

describe("client bootstrap", () => {
  it("mounts the administrator application with its plugins", () => {
    expect(mocks.createWebHistory).toHaveBeenCalledOnce();
    expect(mocks.createRouter).toHaveBeenCalledWith({
      history: "history",
      routes: [{ component: "AdminView", path: "/admin" }],
    });
    expect(mocks.createApp).toHaveBeenCalledWith("App");
    expect(mocks.use).toHaveBeenNthCalledWith(1, "pinia");
    expect(mocks.use).toHaveBeenNthCalledWith(2, "router");
    expect(mocks.use).toHaveBeenNthCalledWith(3, "vuetify");
    expect(mocks.createVuetify).toHaveBeenCalledWith(
      expect.objectContaining({ directives: { Ripple: "Ripple" } }),
    );
    expect(mocks.mount).toHaveBeenCalledWith("#app");
  });

  it("navigates the root document through the Access-protected admin path", () => {
    const replace = vi.fn();
    const createCalls = mocks.createApp.mock.calls.length;

    startClient({ pathname: "/", replace });

    expect(replace).toHaveBeenCalledWith("/admin");
    expect(mocks.createApp).toHaveBeenCalledTimes(createCalls);
  });
});
