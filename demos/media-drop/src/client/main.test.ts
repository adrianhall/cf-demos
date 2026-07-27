import { afterEach, describe, expect, it } from "vitest";

describe("client bootstrap", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("mounts the routed Vuetify application", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import("./main");

    expect(document.querySelector("#app .v-application")).not.toBeNull();
  });
});
