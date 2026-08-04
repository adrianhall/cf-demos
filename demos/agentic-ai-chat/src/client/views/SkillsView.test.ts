import { createTestingPinia } from "@pinia/testing";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import SkillForm from "../components/SkillForm.vue";
import SkillList from "../components/SkillList.vue";
import { useSkillsStore } from "../stores/skills";
import SkillsView from "./SkillsView.vue";

const stubs = {
  RouterLink: { template: '<a v-bind="$attrs"><slot /></a>' },
  VContainer: { template: "<div><slot /></div>" },
};

describe("SkillsView", () => {
  it("loads the signed-in identity's own skills once mounted", () => {
    mount(SkillsView, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn })],
        stubs,
      },
    });
    const skills = useSkillsStore();

    expect(skills.load).toHaveBeenCalledTimes(1);
  });

  it("shows the store's own error when it is set", () => {
    const wrapper = mount(SkillsView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: { skills: { error: "Could not load your skills." } },
            stubActions: true,
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("Could not load your skills.");
  });

  it("renders the signed-in identity's own personal skills", () => {
    const wrapper = mount(SkillsView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              skills: {
                skills: [
                  {
                    id: "skill-1",
                    name: "trip-planner",
                    sourceType: "upload",
                    sourceRef: null,
                    createdAt: "2026-08-03T00:00:00.000Z",
                  },
                ],
              },
            },
            stubActions: true,
          }),
        ],
        stubs,
      },
    });

    expect(wrapper.text()).toContain("trip-planner");
  });

  it("forwards the skill form's create event to the store's create action", async () => {
    const wrapper = mount(SkillsView, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn, stubActions: true })],
        stubs,
      },
    });
    const skills = useSkillsStore();

    await wrapper.findComponent(SkillForm).vm.$emit("create", {
      name: "trip-planner",
      description: "Use when planning a trip.",
      source: { type: "upload", content: "Plan a trip." },
    });

    expect(skills.create).toHaveBeenCalledWith({
      name: "trip-planner",
      description: "Use when planning a trip.",
      source: { type: "upload", content: "Plan a trip." },
    });
  });

  it("forwards the skill list's remove event to the store's remove action", async () => {
    const wrapper = mount(SkillsView, {
      global: {
        plugins: [
          createTestingPinia({
            createSpy: vi.fn,
            initialState: {
              skills: {
                skills: [
                  {
                    id: "skill-1",
                    name: "trip-planner",
                    sourceType: "upload",
                    sourceRef: null,
                    createdAt: "2026-08-03T00:00:00.000Z",
                  },
                ],
              },
            },
            stubActions: true,
          }),
        ],
        stubs,
      },
    });
    const skills = useSkillsStore();

    await wrapper.findComponent(SkillList).vm.$emit("remove", "skill-1");

    expect(skills.remove).toHaveBeenCalledWith("skill-1");
  });
});
