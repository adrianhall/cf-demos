import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import RouteSelector from "./RouteSelector.vue";

describe("RouteSelector", () => {
  it("renders exactly two options, Basic and Reasoning", () => {
    const wrapper = mount(RouteSelector, {
      props: { route: "basic", disabled: false },
    });

    const options = wrapper.findAll("option");
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.text())).toEqual([
      "Basic",
      "Reasoning",
    ]);
    expect(options.map((option) => option.attributes("value"))).toEqual([
      "basic",
      "reasoning",
    ]);
  });

  it("reflects the currently selected route", () => {
    const wrapper = mount(RouteSelector, {
      props: { route: "reasoning", disabled: false },
    });

    expect((wrapper.get("select").element as HTMLSelectElement).value).toBe(
      "reasoning",
    );
  });

  it("emits change with the newly selected route", async () => {
    const wrapper = mount(RouteSelector, {
      props: { route: "basic", disabled: false },
    });

    await wrapper.get("select").setValue("reasoning");

    expect(wrapper.emitted("change")).toEqual([["reasoning"]]);
  });

  it("never emits change for a value other than basic/reasoning (defensive; not reachable through the rendered options)", async () => {
    const wrapper = mount(RouteSelector, {
      props: { route: "basic", disabled: false },
    });
    const select = wrapper.get("select").element as HTMLSelectElement;
    // A native <select> can only ever report one of its own <option> values -- this simulates
    // an impossible DOM state directly, since neither rendered option is anything but
    // "basic"/"reasoning", to prove onChange's own type-narrowing guard is a genuine no-op
    // rather than dead code.
    const injected = document.createElement("option");
    injected.value = "not-a-real-route";
    select.appendChild(injected);
    select.value = "not-a-real-route";

    await wrapper.get("select").trigger("change");

    expect(wrapper.emitted("change")).toBeUndefined();
  });

  it("disables the control once the chat has turns", () => {
    const wrapper = mount(RouteSelector, {
      props: { route: "basic", disabled: true },
    });

    expect(wrapper.get("select").attributes("disabled")).toBeDefined();
  });

  it("does not disable the control while the chat has no turns yet", () => {
    const wrapper = mount(RouteSelector, {
      props: { route: "basic", disabled: false },
    });

    expect(wrapper.get("select").attributes("disabled")).toBeUndefined();
  });
});
