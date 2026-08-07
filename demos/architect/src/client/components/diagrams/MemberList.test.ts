import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { useDiagramMembersStore } from "../../stores/diagram-members";
import MemberList from "./MemberList.vue";

const stubs = {
  FeatherIcon: true,
  VAlert: { template: "<div><slot /></div>" },
  VProgressCircular: { template: "<div />" },
  VChip: { template: "<span><slot /></span>" },
};

function mountList(initialState: Record<string, unknown> = {}) {
  const pinia = createTestingPinia({
    createSpy: vi.fn,
    initialState: { "diagram-members": initialState },
  });
  const wrapper = mount(MemberList, {
    global: { plugins: [pinia], stubs },
    props: { diagramId: "diagram-1" },
  });
  return { store: useDiagramMembersStore(), wrapper };
}

describe("MemberList", () => {
  it("loads members for the given diagram on mount", () => {
    const { store } = mountList();
    expect(store.load).toHaveBeenCalledWith("diagram-1");
  });

  it("renders every member with their role", () => {
    const { wrapper } = mountList({
      members: [
        { email: "owner@example.com", role: "owner" },
        { email: "editor@example.com", role: "editor" },
      ],
    });
    expect(wrapper.text()).toContain("owner@example.com");
    expect(wrapper.text()).toContain("editor@example.com");
    expect(wrapper.text()).toContain("owner");
    expect(wrapper.text()).toContain("editor");
  });

  it("shows a loading indicator while the initial load is pending", () => {
    const { wrapper } = mountList({ loading: true });
    expect(wrapper.find(".member-list ul").exists()).toBe(false);
  });

  it("shows a store error message", () => {
    const { wrapper } = mountList({ error: "Diagram not found." });
    expect(wrapper.text()).toContain("Diagram not found.");
  });
});
