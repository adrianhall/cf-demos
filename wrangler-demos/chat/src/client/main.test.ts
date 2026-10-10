import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const app = {
    mount: vi.fn(),
    use: vi.fn(),
  };
  return {
    app,
    createApp: vi.fn(() => app),
    createPinia: vi.fn(() => "pinia"),
    createRouter: vi.fn(() => "router"),
    createVuetify: vi.fn(() => "vuetify"),
    createWebHistory: vi.fn(() => "history"),
  };
});

vi.mock("pinia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("pinia")>()),
  createPinia: mocks.createPinia,
}));
vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  createApp: mocks.createApp,
}));
vi.mock("vue-router", () => ({
  createRouter: mocks.createRouter,
  createWebHistory: mocks.createWebHistory,
}));
vi.mock("vuetify", () => ({ createVuetify: mocks.createVuetify }));
vi.mock("vuetify/components", () => ({
  VAlert: "VAlert",
  VApp: "VApp",
  VBtn: "VBtn",
  VList: "VList",
  VListItem: "VListItem",
  VListItemTitle: "VListItemTitle",
  VMain: "VMain",
  VTextField: "VTextField",
}));

describe("startClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.app.use.mockReturnValue(mocks.app);
    mocks.app.mount.mockReturnValue(undefined);
  });

  it("installs Pinia, Router, and Vuetify before mounting the application", async () => {
    const { startClient } = await import("./main");

    expect(mocks.app.mount).toHaveBeenCalledWith("#app");
    vi.clearAllMocks();

    startClient();

    expect(mocks.createRouter).toHaveBeenCalledWith({
      history: "history",
      routes: [expect.objectContaining({ path: "/" })],
    });
    expect(mocks.app.use).toHaveBeenNthCalledWith(1, "pinia");
    expect(mocks.app.use).toHaveBeenNthCalledWith(2, "router");
    expect(mocks.app.use).toHaveBeenNthCalledWith(3, "vuetify");
    expect(mocks.app.mount).toHaveBeenCalledWith("#app");
  });
});
