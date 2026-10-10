import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const root = { render: vi.fn() };
  return {
    createRoot: vi.fn(() => root),
    root,
  };
});

vi.mock("react-dom/client", () => ({ createRoot: mocks.createRoot }));

describe("startClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.documentElement.style.colorScheme = "";
    document.body.innerHTML = '<div id="root"></div>';
  });

  it("mounts the App component into #root on import", async () => {
    const { startClient } = await import("./main");

    expect(mocks.createRoot).toHaveBeenCalledWith(
      document.getElementById("root"),
    );
    expect(mocks.root.render).toHaveBeenCalled();
    vi.clearAllMocks();

    startClient();

    expect(mocks.createRoot).toHaveBeenCalledWith(
      document.getElementById("root"),
    );
    expect(mocks.root.render).toHaveBeenCalled();
  });

  it("throws when #root is missing", async () => {
    const { startClient } = await import("./main");
    document.body.innerHTML = "";

    expect(() => startClient()).toThrow("#root element not found");
  });

  it("applies a stored theme preference before mounting", async () => {
    localStorage.setItem("theme", "dark");
    const { startClient } = await import("./main");

    startClient();

    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("applies no color-scheme override with no stored preference", async () => {
    const { startClient } = await import("./main");

    startClient();

    expect(document.documentElement.style.colorScheme).toBe("");
  });
});
