import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PropertiesPanel from "./PropertiesPanel.vue";

const node = { id: "workers", type: "product" as const, position: { x: 0, y: 0 }, data: { productId: "workers" as const, label: "Workers", description: "Edge logic" } };

describe("PropertiesPanel", () => {
  it("emits edits in writable mode", async () => {
    const wrapper = mount(PropertiesPanel, { props: { node, readOnly: false } });
    await wrapper.get("input").setValue("Public API");
    expect(wrapper.emitted("updateNode")?.[0]?.[0]).toMatchObject({ data: { label: "Public API" } });
  });

  it("disables every editable control in true read-only mode", () => {
    const wrapper = mount(PropertiesPanel, { props: { node, readOnly: true } });
    expect(wrapper.get("input").attributes("disabled")).toBeDefined();
    expect(wrapper.get("textarea").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("Read-only");
  });
});
